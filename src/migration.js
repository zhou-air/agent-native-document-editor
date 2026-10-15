import fs from "node:fs";
import path from "node:path";
import { SqliteRepository } from "./repository.js";
import { semanticNode, assetRefs, Fault } from "./model.js";
import { uid } from "./content.js";
import { DEFAULT_EXPORT_TEMPLATE } from "./docx-export.js";

export const DEFAULT_STYLES = DEFAULT_EXPORT_TEMPLATE;

export function exportStyles(styles) {
  if (!styles || typeof styles !== "object" || Array.isArray(styles))
    throw new Fault("导出模板必须是对象");
  // This independent output template is the only place where presentation belongs.
  const pick = (source, keys) =>
    Object.fromEntries(
      keys.filter((k) => source?.[k] != null).map((k) => [k, source[k]]),
    );
  const rule = (s) => ({
    font: pick(s?.font, [
      "eastAsia",
      "latin",
      "ascii",
      "sizePt",
      "bold",
      "italic",
    ]),
    paragraph: {
      ...pick(s?.paragraph, [
        "beforePt",
        "afterPt",
        "line",
        "lineRule",
        "alignment",
      ]),
      ...(s?.paragraph?.indent
        ? {
            indent: pick(s.paragraph.indent, [
              "left",
              "right",
              "firstLine",
              "hanging",
            ]),
          }
        : {}),
    },
  });
  const semantic = styles.semantic || DEFAULT_STYLES.semantic,
    page = styles.pages?.[0] || DEFAULT_STYLES.pages[0];
  return {
    formatVersion: 2,
    semantic: {
      body: rule(semantic.body || DEFAULT_STYLES.semantic.body),
      headings: Object.fromEntries(
        Object.entries(semantic.headings || {})
          .filter(([k]) => /^[1-9]$/.test(k))
          .map(([k, v]) => [k, rule(v)]),
      ),
      table: rule(semantic.table || DEFAULT_STYLES.semantic.table),
    },
    pages: [
      {
        size: pick(page.size, ["w", "h", "orient"]),
        margins: pick(page.margins, [
          "top",
          "bottom",
          "left",
          "right",
          "header",
          "footer",
          "gutter",
        ]),
      },
    ],
  };
}

export function createDatabase(file, project, directory) {
  const repo = new SqliteRepository(file);
  const report = {
    formatVersion: 2,
    timestamp: new Date().toISOString(),
    sourceSections: project.sections.length,
    sourceBlocks: 0,
    preservedBlockIds: 0,
    mappings: [],
    syntheticHeadings: [],
    verified: false,
  };
  try {
    const ids = new Set(),
      sectionMap = new Map();
    const identity = (candidate, kind) => {
      let id =
        typeof candidate === "string" && candidate.length ? candidate : uid();
      if (ids.has(id)) {
        const next = uid();
        report.mappings.push({
          kind,
          oldId: id,
          newId: next,
          reason: "duplicate",
        });
        id = next;
      }
      if (!candidate)
        report.mappings.push({
          kind,
          oldId: null,
          newId: id,
          reason: "missing",
        });
      ids.add(id);
      return id;
    };
    const sections = project.sections.map((s) => {
      const id = identity(s.id, "section");
      if (!sectionMap.has(s.id)) sectionMap.set(s.id, id);
      return { source: s, id, blocks: [] };
    });
    repo.transaction(() => {
      repo.run(
        "INSERT INTO documents VALUES(?,?,?,?,?,?,?)",
        project.id || uid(),
        project.title || "未命名文档",
        Math.max(1, project.revision || 1),
        JSON.stringify(exportStyles(project.styles || DEFAULT_STYLES)),
        JSON.stringify(project.warnings || []),
        typeof project.original === "string"
          ? project.original
          : project.original
            ? "original/source.docx"
            : null,
        new Date().toISOString(),
      );
      const counters = new Map();
      for (const entry of sections) {
        const s = entry.source;
        const parent = s.parentId ? sectionMap.get(s.parentId) : null;
        if (s.parentId && !parent)
          throw new Fault("迁移失败：章节父节点不存在 " + s.id);
        const chain = new Set([s.id]);
        let p = s.parentId;
        while (p) {
          if (chain.has(p)) throw new Fault("迁移失败：章节层级存在循环");
          chain.add(p);
          p = project.sections.find((x) => x.id === p)?.parentId;
        }
        let sourceBlocks = s.blocks || [];
        report.sourceBlocks += sourceBlocks.length;
        let headingSource =
          sourceBlocks.find((b) => b.id === s.headingBlockId) ||
          (sourceBlocks[0]?.type === "heading" ? sourceBlocks[0] : null);
        if (!headingSource) {
          headingSource = {
            id: uid(),
            type: "heading",
            node: {
              type: "heading",
              content: [{ type: "text", text: s.title || "前言" }],
            },
            revision: 1,
          };
          sourceBlocks = [headingSource, ...sourceBlocks];
          report.syntheticHeadings.push({
            sectionId: entry.id,
            headingBlockId: headingSource.id,
            title: s.title || "前言",
          });
        }
        for (let i = 0; i < sourceBlocks.length; i++) {
          const b = sourceBlocks[i],
            id = identity(b.id || b.node?.attrs?.id, "block");
          if (
            (id === b.id && b !== headingSource) ||
            (id === b.id && (s.blocks || []).includes(b))
          )
            report.preservedBlockIds++;
          const content = semanticNode(b.node || b.content);
          if (b === headingSource && content.type !== "heading")
            throw new Fault("章节标题必须是 Heading");
          for (const ref of assetRefs(content))
            if (!fs.existsSync(path.join(directory, ref)))
              throw new Fault("迁移失败：图片资源缺失 " + ref);
          entry.blocks.push({
            id,
            section_id: entry.id,
            position: i * 1024,
            type: content.type,
            content: JSON.stringify(content),
            revision: Math.max(1, b.revision || 1),
            sourceId: b.id,
          });
          if (b === headingSource) entry.heading = id;
        }
        const prior = counters.get(parent) || 0;
        counters.set(parent, prior + 1);
        entry.row = {
          id: entry.id,
          parent_id: parent,
          heading_block_id: entry.heading,
          position: (prior + 1) * 1024,
          revision: Math.max(1, s.revision || 1),
        };
      }
      // Legacy own blocks precede children. V2 exports carry authoritative mixed entries.
      for (const entry of sections) {
        const children = sections.filter((x) => x.row.parent_id === entry.id);
        let order = entry.source.entries;
        if (!order)
          order = [
            ...entry.blocks.map((b) => ({
              kind: "block",
              id: b.sourceId || b.id,
            })),
            ...children.map((c) => ({ kind: "section", id: c.source.id })),
          ];
        const positioned = new Set();
        let next = 0;
        for (const item of order) {
          const entity =
            item.kind === "section"
              ? children.find((c) => c.source.id === item.id)?.row
              : entry.blocks.find(
                  (b) => b.sourceId === item.id || b.id === item.id,
                );
          if (entity) {
            entity.position = next++ * 1024;
            positioned.add(entity.id);
          }
        }
        for (const entity of [...entry.blocks, ...children.map((c) => c.row)])
          if (!positioned.has(entity.id)) entity.position = next++ * 1024;
        const heading = entry.blocks.find((b) => b.id === entry.heading);
        heading.position = -1024;
      }
      if (project.rootEntries)
        project.rootEntries.forEach((e, i) => {
          const s = sections.find((x) => x.source.id === e.id);
          if (s && s.row.parent_id === null) s.row.position = i * 1024;
        });
      for (const s of sections) repo.putSection(s.row);
      for (const s of sections) for (const b of s.blocks) repo.putBlock(b);
      for (const entry of fs.readdirSync(path.join(directory, "assets"), {
        withFileTypes: true,
      }))
        if (entry.isFile()) {
          const ref = "assets/" + entry.name;
          repo.run(
            "INSERT INTO assets VALUES(?,?,?)",
            ref,
            path.extname(entry.name).slice(1),
            fs.statSync(path.join(directory, ref)).size,
          );
        }
    });
    repo.integrity();
    // Verify every normalized input independently against readback before activation.
    for (const s of sections)
      for (const b of s.blocks) {
        const readback = repo.block(b.id);
        if (
          !readback ||
          readback.content !== b.content ||
          readback.section_id !== s.id
        )
          throw new Fault("迁移后正文或归属核验失败");
      }
    const visited = new Set(),
      sectionOrder = [];
    const visit = (parent) => {
      for (const e of repo.entries(parent))
        if (e.kind === "section") {
          if (visited.has(e.id)) throw new Fault("迁移后章节存在循环");
          visited.add(e.id);
          sectionOrder.push(e.id);
          visit(e.id);
        }
    };
    visit(null);
    if (visited.size !== sections.length) throw new Fault("迁移后出现孤立章节");
    if (
      project.formatVersion === 1 &&
      JSON.stringify(sectionOrder) !== JSON.stringify(sections.map((s) => s.id))
    )
      throw new Fault(
        "旧项目的章节顺序与父子层级冲突，已停止迁移以避免正文顺序变化；请先整理旧项目层级。",
      );
    report.sections = sections.length;
    report.blocks = sections.reduce((n, s) => n + s.blocks.length, 0);
    report.verified = true;
    repo.checkpoint();
    return report;
  } finally {
    repo.close();
  }
}

/** Back up first; activate only a closed, fully validated database. The v1 files remain intact. */
export function migrateLegacy(directory) {
  const input = path.join(directory, "project.json");
  const backup = path.join(
    directory,
    "backups",
    "v1-" +
      new Date().toISOString().replace(/[:.]/g, "-") +
      "-" +
      uid().slice(0, 8),
  );
  fs.mkdirSync(backup, { recursive: true });
  for (const name of ["project.json", "styles.json", "assets", "original"]) {
    const p = path.join(directory, name);
    if (fs.existsSync(p))
      fs.cpSync(p, path.join(backup, name), { recursive: true });
  }
  const old = JSON.parse(fs.readFileSync(input, "utf8"));
  if (old.formatVersion !== 1)
    throw new Fault("旧项目版本不受支持；原文件已备份");
  fs.mkdirSync(path.join(directory, "assets"), { recursive: true });
  const temp = path.join(directory, "migration-" + uid() + ".sqlite");
  try {
    const report = createDatabase(temp, old, directory);
    report.backup = backup;
    report.limitations = [
      "校验旧项目已保存的语义内容；无法自动恢复旧导入器已漏导的内容。",
      "来源字体、字号、行距、XML 与样式镜像不迁移到正文。",
    ];
    fs.writeFileSync(
      path.join(directory, "migration-report.json"),
      JSON.stringify(report, null, 2),
    );
    fs.renameSync(temp, path.join(directory, "document.sqlite"));
    return report;
  } catch (e) {
    for (const suffix of ["", "-wal", "-shm"])
      if (fs.existsSync(temp + suffix)) fs.rmSync(temp + suffix);
    throw e;
  }
}
