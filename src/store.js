import fs from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";
import JSZip from "jszip";
import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { TableKit } from "@tiptap/extension-table";
import Image from "@tiptap/extension-image";
import UniqueID from "@tiptap/extension-unique-id";
import {
  uid,
  block,
  assignIds,
  fromMarkdown,
  plain,
  replaceText,
} from "./content.js";
const schema = getSchema([
  StarterKit,
  TableKit,
  Image,
  UniqueID.configure({ types: "all" }),
]);
export class Fault extends Error {
  constructor(message, code = 400) {
    super(message);
    this.code = code;
  }
}
export function atomic(file, data) {
  const temp = file + "." + uid() + ".tmp";
  const fd = fs.openSync(temp, "wx");
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(temp, file);
  } catch (e) {
    fs.rmSync(temp, { force: true });
    throw e;
  }
}
export function validateNode(n) {
  try {
    schema.nodeFromJSON(n).check();
  } catch (e) {
    throw new Fault("无效的编辑器节点：" + e.message);
  }
  function check(x) {
    if (x.type === "image" && !/^assets\/[\w.-]+$/.test(x.attrs?.src || ""))
      throw new Fault("图片仅允许项目 assets/ 相对路径");
    for (const c of x.content || []) check(c);
  }
  check(n);
}
export class Store {
  constructor() {
    this.project = null;
    this.dir = null;
    this.release = null;
    this.listeners = new Set();
  }
  close() {
    if (this.release) this.release();
    this.release = null;
    this.project = null;
    this.dir = null;
  }
  open(dir) {
    dir = path.resolve(dir);
    if (this.dir === dir) return this.snapshot();
    if (!fs.existsSync(path.join(dir, "project.json")))
      throw new Fault("该目录不是 Agent Document 项目");
    const release = lockfile.lockSync(dir, { realpath: true, stale: 30000 });
    let p;
    try {
      p = JSON.parse(fs.readFileSync(path.join(dir, "project.json"), "utf8"));
      if (p.formatVersion !== 1) throw new Fault("不支持的项目版本");
      this.normalize(p);
      this.validate(p);
    } catch (e) {
      release();
      throw e;
    }
    this.close();
    this.release = release;
    this.dir = dir;
    this.project = p;
    this.mirrors();
    return this.snapshot();
  }
  create(dir, title, imported = null) {
    dir = path.resolve(dir);
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(path.join(dir, "project.json")))
      throw new Fault("目录中已存在项目，不能覆盖");
    const release = lockfile.lockSync(dir, { realpath: true, stale: 30000 });
    try {
      const p = imported
        ? structuredClone({
            ...imported,
            assets: undefined,
            original: undefined,
          })
        : {
            id: uid(),
            formatVersion: 1,
            title: title || "未命名文档",
            revision: 1,
            sections: [
              {
                id: uid(),
                title: "1 项目概述",
                level: 1,
                parentId: null,
                blocks: [
                  block(
                    assignIds({
                      type: "heading",
                      attrs: { level: 1 },
                      content: [{ type: "text", text: "1 项目概述" }],
                    }),
                  ),
                  block(
                    assignIds({
                      type: "paragraph",
                      content: [
                        {
                          type: "text",
                          text: "在这里开始编写。每个内容块都有稳定 ID，人类和 Agent 共同编辑同一份本地文档。",
                        },
                      ],
                    }),
                  ),
                ],
              },
            ],
            styles: {
              formatVersion: 1,
              semantic: {
                body: { font: { eastAsia: "宋体", sizePt: 12 } },
                headings: {},
              },
              pages: [],
              definitions: {},
              localOverrides: {},
            },
            warnings: [],
          };
      fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
      if (imported) {
        for (const [name, bytes] of Object.entries(imported.assets))
          fs.writeFileSync(path.join(dir, name), bytes);
        fs.mkdirSync(path.join(dir, "original"), { recursive: true });
        fs.writeFileSync(
          path.join(dir, "original/source.docx"),
          imported.original,
        );
        p.original = "original/source.docx";
      }
      this.normalize(p);
      this.validate(p);
      atomic(path.join(dir, "project.json"), JSON.stringify(p, null, 2));
      this.close();
      this.release = release;
      this.dir = dir;
      this.project = p;
      this.mirrors();
      return this.snapshot();
    } catch (e) {
      release();
      throw e;
    }
  }
  normalize(p, previous = null) {
    const prior = new Map(
      (previous?.sections || []).flatMap((s) => s.blocks).map((b) => [b.id, b]),
    );
    p.sections.forEach((s, i) => {
      s.order = i;
      s.revision ??= 1;
      s.blocks.forEach((b, j) => {
        const old = prior.get(b.id);
        if (old && JSON.stringify(old.node) === JSON.stringify(b.node)) {
          b.node = old.node;
          b.markdown = old.markdown;
        } else {
          assignIds(b.node);
          b.node = schema.nodeFromJSON(b.node).toJSON();
          b.markdown = block(b.node).markdown;
        }
        b.order = j;
        b.sectionId = s.id;
        b.revision ??= 1;
      });
    });
  }
  validate(p) {
    const ids = new Set();
    for (const s of p.sections) {
      if (ids.has(s.id)) throw new Fault("重复章节 ID");
      ids.add(s.id);
      for (const b of s.blocks) {
        validateNode(b.node);
        function walk(n) {
          if (n.type !== "text" && n.type !== "doc") {
            const id = n.attrs?.id;
            if (!id || ids.has(id)) throw new Fault("缺失或重复块 ID");
            ids.add(id);
          }
          for (const c of n.content || []) walk(c);
        }
        walk(b.node);
        if (b.id !== b.node.attrs?.id) throw new Fault("块 ID 不一致");
      }
    }
  }
  snapshot() {
    if (!this.project) throw new Fault("请先打开项目", 404);
    return structuredClone({ ...this.project, path: this.dir });
  }
  mirrors() {
    try {
      atomic(
        path.join(this.dir, "styles.json"),
        JSON.stringify(this.project.styles, null, 2),
      );
    } catch (e) {
      this.mirrorWarning = e.message;
    }
  }
  transaction(fn) {
    if (!this.project) throw new Fault("请先打开项目", 404);
    const next = structuredClone(this.project);
    const result = fn(next);
    next.revision++;
    next.updatedAt = new Date().toISOString();
    this.normalize(next, this.project);
    this.validate(next);
    atomic(path.join(this.dir, "project.json"), JSON.stringify(next, null, 2));
    this.project = next;
    this.mirrors();
    for (const f of this.listeners) f(next.revision);
    return result ?? this.snapshot();
  }
  section(p, id) {
    const s = p.sections.find((s) => s.id === id);
    if (!s) throw new Fault("章节不存在", 404);
    return s;
  }
  locate(p, id) {
    for (const s of p.sections) {
      const i = s.blocks.findIndex((b) => b.id === id);
      if (i >= 0) return { s, b: s.blocks[i], i };
    }
    throw new Fault(
      "块不存在（工具操作章节直属块；嵌套节点包含在其内容中）",
      404,
    );
  }
  expect(actual, expected) {
    if (!Number.isInteger(expected) || actual !== expected)
      throw new Fault(
        `版本冲突：期望 ${expected}，当前 ${actual}。请重新读取；原内容未被覆盖。`,
        409,
      );
  }
  node(input) {
    const nodes = input.node
      ? [structuredClone(input.node)]
      : fromMarkdown(input.markdown ?? "");
    if (nodes.length !== 1) throw new Fault("块内容必须恰好包含一个顶层节点");
    assignIds(nodes[0]);
    validateNode(nodes[0]);
    return nodes[0];
  }
  apply(name, a = {}) {
    const p = this.project;
    if (name === "project_info")
      return {
        id: p.id,
        title: p.title,
        revision: p.revision,
        path: this.dir,
        sectionCount: p.sections.length,
        warnings: p.warnings,
      };
    if (name === "list_sections")
      return p.sections.map(({ blocks, ...s }) => ({
        ...s,
        blockCount: blocks.length,
      }));
    if (name === "read_section")
      return structuredClone(this.section(p, a.section_id));
    if (name === "list_blocks")
      return this.section(p, a.section_id).blocks.map(
        ({ node, source, ...b }) => b,
      );
    if (name === "read_block")
      return structuredClone(this.locate(p, a.block_id).b);
    return this.transaction((next) => {
      if (name === "save_section") {
        const s = this.section(next, a.section_id);
        const ids = a.nodes.map((n) => n.attrs?.id);
        const oldIds = s.blocks.map((b) => b.id);
        const structural = JSON.stringify(ids) !== JSON.stringify(a.base_ids);
        if (structural) {
          this.expect(s.revision, a.section_revision);
          if (JSON.stringify(oldIds) !== JSON.stringify(a.base_ids))
            throw new Fault("章节结构已变化", 409);
        }
        const changed = new Map(a.changed.map((n) => [n.attrs.id, n]));
        for (const [id, n] of changed) {
          const old = s.blocks.find((b) => b.id === id);
          if (old) this.expect(old.revision, a.versions[id]);
          else if (!structural) throw new Fault("新增块必须提交结构变化");
        }
        const order = structural ? ids : oldIds;
        s.blocks = order.map((id) => {
          const old = s.blocks.find((b) => b.id === id);
          if (!changed.has(id)) {
            if (!old) throw new Fault("缺少新增块内容");
            return old;
          }
          return {
            ...block(changed.get(id), old),
            revision: (old?.revision || 0) + 1,
          };
        });
        s.revision++;
        this.syncTitle(s);
        return;
      }
      if (name === "write_section") {
        const s = this.section(next, a.section_id);
        this.expect(s.revision, a.expected_revision);
        const old = new Map(s.blocks.map((b) => [b.id, b]));
        const nodes = a.nodes || fromMarkdown(a.markdown ?? "");
        s.blocks = nodes.map((n) => ({
          ...block(assignIds(n), old.get(n.attrs?.id)),
          revision: (old.get(n.attrs?.id)?.revision || 0) + 1,
        }));
        s.revision++;
        this.syncTitle(s);
        return;
      }
      if (name === "restore_sections") {
        this.expect(next.revision, a.expected_revision);
        for (const snapshot of a.sections) {
          const current = this.section(next, snapshot.id);
          current.blocks = structuredClone(snapshot.blocks).map((b) => ({
            ...b,
            revision:
              Math.max(
                b.revision || 0,
                current.blocks.find((x) => x.id === b.id)?.revision || 0,
              ) + 1,
          }));
          current.title = snapshot.title;
          current.revision++;
        }
        return;
      }
      if (name === "add_section") {
        this.expect(next.revision, a.expected_revision);
        const l = Math.max(1, Math.min(9, Number(a.level) || 1)),
          s = {
            id: uid(),
            title: a.title || "新章节",
            level: l,
            parentId: a.parent_id || null,
            revision: 1,
            blocks: [],
          };
        if (s.parentId) this.section(next, s.parentId);
        s.blocks = [
          block(
            assignIds({
              type: "heading",
              attrs: { level: Math.min(l, 6) },
              content: [{ type: "text", text: s.title }],
            }),
          ),
        ];
        next.sections.push(s);
        return;
      }
      if (name === "styles") {
        this.expect(next.revision, a.expected_revision);
        if (
          !a.styles ||
          typeof a.styles !== "object" ||
          Array.isArray(a.styles)
        )
          throw new Fault("样式必须是 JSON 对象");
        next.styles = a.styles;
        return;
      }
      if (name === "insert_block") {
        const s = this.section(next, a.section_id);
        this.expect(s.revision, a.expected_revision);
        const n = assignIds(this.node(a), true),
          b = block(n);
        const i = a.after_id
          ? s.blocks.findIndex((b) => b.id === a.after_id) + 1
          : s.blocks.length;
        if (a.after_id && i === 0) throw new Fault("插入锚点不存在");
        s.blocks.splice(i, 0, { ...b, revision: 1 });
        s.revision++;
        return;
      }
      const { s, b, i } = this.locate(next, a.block_id);
      this.expect(b.revision, a.expected_revision);
      if (name === "update_block") {
        const n = this.node(a);
        n.attrs.id = b.id;
        s.blocks[i] = { ...block(n, b), revision: b.revision + 1 };
      } else if (name === "delete_block") s.blocks.splice(i, 1);
      else if (name === "replace_text") {
        const n = replaceText(b.node, a.old_text, a.new_text);
        s.blocks[i] = { ...block(n, b), revision: b.revision + 1 };
      } else if (name === "move_block") {
        const dest = this.section(next, a.section_id);
        this.expect(dest.revision, a.target_revision);
        s.blocks.splice(i, 1);
        const ix = a.before_id
          ? dest.blocks.findIndex((b) => b.id === a.before_id)
          : dest.blocks.length;
        if (ix < 0) throw new Fault("移动锚点不存在");
        dest.blocks.splice(ix, 0, b);
        if (dest !== s) dest.revision++;
      } else throw new Fault("未知操作 " + name);
      s.revision++;
      this.syncTitle(s);
    });
  }
  syncTitle(s) {
    if (s.blocks[0]?.type === "heading") s.title = plain(s.blocks[0].node);
  }
  addAsset(bytes, name) {
    if (!this.project) throw new Fault("请先打开项目");
    const ext = path.extname(name).toLowerCase();
    if (![".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"].includes(ext))
      throw new Fault("支持 PNG/JPEG/GIF/WebP/BMP 图片");
    const file = `assets/${uid()}${ext}`;
    fs.writeFileSync(path.join(this.dir, file), bytes);
    return { src: file };
  }
  async export(sectionIds) {
    const p = this.snapshot(),
      base = this.dir;
    const selected = sectionIds?.length
      ? p.sections.filter((s) => sectionIds.includes(s.id))
      : p.sections;
    if (sectionIds?.some((id) => !p.sections.some((s) => s.id === id)))
      throw new Fault("导出章节不存在");
    const zip = new JSZip();
    zip.file(
      "document.md",
      selected
        .map((s) => s.blocks.map((b) => b.markdown).join("\n\n"))
        .join("\n\n"),
    );
    zip.file(
      "structure.json",
      JSON.stringify({ ...p, path: undefined, sections: selected }, null, 2),
    );
    zip.file("styles.json", JSON.stringify(p.styles, null, 2));
    zip.file("export-rules.md", EXPORT_RULES);
    zip.file(
      "word-prompt.txt",
      "请读取 export-rules.md、styles.json 和 structure.json，将 document.md 与 assets 生成完整 Word。逐块核对内容和表格，不得概括、删减或更改技术数据。遇到 warnings 或不能实现的样式，明确报告。",
    );
    for (const f of fs.readdirSync(path.join(base, "assets")))
      zip.file("assets/" + f, fs.readFileSync(path.join(base, "assets", f)));
    zip.folder("assets");
    if (p.original)
      zip.file(
        "original/source.docx",
        fs.readFileSync(path.join(base, p.original)),
      );
    return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  }
}
export const EXPORT_RULES = `# Word 生成规则\n\n1. 完整保留 document.md 全部正文、原始标题编号、列表、加粗、斜体、表格、图片；禁止概括、删减和修改任何技术数据。\n2. structure.json 的稳定章节/块 ID、order 和层级是结构依据；node 为富文本与复杂表格的无损表达，markdown 是其内容表达。不得根据 Markdown 重新推断或重新编号。\n3. 表格 rowspan/colspan 分别对应 Word vMerge/gridSpan。按逻辑网格生成，保留单元格内多段落和图片，不能把合并表格变成普通矩形 Markdown 表格。\n4. 图片使用 assets/ 相对路径，逐个插入，保留 alt 信息。\n5. styles.json semantic 是可复用语义样式；definitions 是 Word 原始样式定义，localOverrides 保留块来源局部格式。显式 false 不能当作未设置。pages 使用 twips；字体和段距用 pt。用户修改后的 semantic 优先。按 Word 样式及局部覆盖生成；页面边距和纸张尺寸据 pages。\n6. 逐条处理 structure.json warnings；原始 Word 在 original/source.docx，无法转换的公式、浮动图形、页眉页脚、修订等必须对照原文件，不能静默丢弃。\n7. 生成完成后核对每个块正文、编号、图片引用、表格逻辑矩阵，提供缺失与格式差异报告。只有全部核验后才可称为完整转换。\n8. 可用 python-docx 或 Pandoc。Pandoc 的 reference-doc 提供样式与页面设置，但不保证复杂合并表格和来源局部样式完整，必要时后处理 OOXML。\n`;
