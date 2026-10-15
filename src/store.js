import fs from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";
import JSZip from "jszip";
import { uid, markdown, plain, fromMarkdown, replaceText } from "./content.js";
import { Fault, semanticNode, assetRefs, expect } from "./model.js";
import { SqliteRepository } from "./repository.js";
import {
  createDatabase,
  migrateLegacy,
  exportStyles,
  DEFAULT_STYLES,
} from "./migration.js";
export { Fault } from "./model.js";
export function atomic(file, data) {
  const temp = file + "." + uid() + ".tmp",
    fd = fs.openSync(temp, "wx");
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
export const validateNode = (n) => semanticNode(n);

export class Store {
  constructor({
    repositoryFactory = (file) => new SqliteRepository(file),
  } = {}) {
    this.repositoryFactory = repositoryFactory;
    this.repo = null;
    this.dir = null;
    this.release = null;
    this.listeners = new Set();
    this.frame = null;
  }
  get project() {
    const d = this.repo?.document();
    return d
      ? {
          id: d.id,
          title: d.title,
          revision: d.revision,
          formatVersion: 2,
          updatedAt: d.updated_at,
        }
      : null;
  }
  close() {
    this.repo?.close();
    this.repo = null;
    this.release?.();
    this.release = null;
    this.dir = null;
  }
  require() {
    if (!this.repo) throw new Fault("请先打开项目", 404);
  }
  open(directory) {
    const dir = path.resolve(directory);
    if (this.dir === dir) return this.manifest();
    if (
      !fs.existsSync(path.join(dir, "document.sqlite")) &&
      !fs.existsSync(path.join(dir, "project.json"))
    )
      throw new Fault("该目录不是 Agent Document 项目");
    const release = lockfile.lockSync(dir, { realpath: true, stale: 30000 });
    let repo;
    try {
      if (!fs.existsSync(path.join(dir, "document.sqlite"))) migrateLegacy(dir);
      repo = this.repositoryFactory(path.join(dir, "document.sqlite"));
      if (!repo.document()) throw new Fault("数据库没有文档身份");
      repo.integrity();
    } catch (e) {
      repo?.close();
      release();
      throw e;
    }
    this.close();
    this.release = release;
    this.repo = repo;
    this.dir = dir;
    return this.manifest();
  }
  create(directory, title, imported = null) {
    const dir = path.resolve(directory);
    fs.mkdirSync(dir, { recursive: true });
    if (
      ["document.sqlite", "project.json"].some((n) =>
        fs.existsSync(path.join(dir, n)),
      )
    )
      throw new Fault("目录已有项目，不能覆盖");
    const release = lockfile.lockSync(dir, { realpath: true, stale: 30000 }),
      temp = path.join(dir, "create-" + uid() + ".sqlite");
    try {
      fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
      if (imported) {
        for (const [name, bytes] of Object.entries(imported.assets || {})) {
          if (!/^assets\/[\w.-]+$/.test(name)) throw new Fault("非法资源路径");
          fs.writeFileSync(path.join(dir, name), bytes);
        }
        if (Buffer.isBuffer(imported.original)) {
          fs.mkdirSync(path.join(dir, "original"), { recursive: true });
          fs.writeFileSync(
            path.join(dir, "original/source.docx"),
            imported.original,
          );
        }
      }
      const heading = uid();
      const p = imported ? { ...imported } : {
        id: uid(),
        title: title || "未命名文档",
        revision: 1,
        styles: DEFAULT_STYLES,
        warnings: [],
        sections: [
          {
            id: uid(),
            title: "1 项目概述",
            parentId: null,
            headingBlockId: heading,
            revision: 1,
            blocks: [
              {
                id: heading,
                type: "heading",
                node: {
                  type: "heading",
                  content: [{ type: "text", text: "1 项目概述" }],
                },
              },
              {
                id: uid(),
                type: "paragraph",
                node: {
                  type: "paragraph",
                  content: [{ type: "text", text: "在这里开始编写。" }],
                },
              },
            ],
          },
        ],
      };
      if (imported && typeof title === "string" && title.trim()) p.title = title.trim();
      const report = createDatabase(temp, p, dir);
      if (imported)
        atomic(
          path.join(dir, "import-report.json"),
          JSON.stringify(
            {
              ...report,
              idMappings: imported.idMappings || [],
              warnings: imported.warnings || [],
            },
            null,
            2,
          ),
        );
      fs.renameSync(temp, path.join(dir, "document.sqlite"));
    } catch (e) {
      for (const suffix of ["", "-wal", "-shm"])
        fs.rmSync(temp + suffix, { force: true });
      release();
      throw e;
    }
    release();
    return this.open(dir);
  }
  sectionRow(id) {
    this.require();
    const s = this.repo.section(id);
    if (!s) throw new Fault("章节不存在", 404);
    return s;
  }
  blockRow(id) {
    this.require();
    const b = this.repo.block(id);
    if (!b) throw new Fault("块不存在", 404);
    return b;
  }
  level(s) {
    let level = 1;
    const seen = new Set([s.id]);
    while (s.parent_id) {
      if (seen.has(s.parent_id)) throw new Fault("章节循环");
      seen.add(s.parent_id);
      s = this.sectionRow(s.parent_id);
      level++;
    }
    return level;
  }
  blockView(b) {
    const content = JSON.parse(b.content),
      node = structuredClone(content);
    node.attrs = { ...node.attrs, id: b.id };
    if (b.type === "heading" && this.repo.section(b.section_id))
      node.attrs.level = this.level(this.sectionRow(b.section_id));
    return {
      id: b.id,
      type: b.type,
      revision: b.revision,
      sectionId: b.section_id,
      order: b.position,
      content,
      node,
      markdown: markdown(node),
    };
  }
  sectionView(s, withIds = false) {
    const h = this.repo.block(s.heading_block_id);
    const result = {
      id: s.id,
      parentId: s.parent_id,
      headingBlockId: s.heading_block_id,
      title: h ? plain(JSON.parse(h.content)) : "",
      level: this.level(s),
      order: s.position,
      revision: s.revision,
      blockCount: this.repo.get(
        "SELECT COUNT(*) n FROM blocks WHERE section_id=?",
        s.id,
      ).n,
    };
    if (withIds) {
      result.blockIds = this.repo
        .all(
          "SELECT id FROM blocks WHERE section_id=? ORDER BY position,id",
          s.id,
        )
        .map((b) => b.id);
      result.entries = this.repo
        .entries(s.id)
        .map(({ id, kind }) => ({ id, kind }));
    }
    return result;
  }
  listSections() {
    this.require();
    const all = this.repo.sections(),
      children = new Map();
    for (const s of all) {
      if (!children.has(s.parent_id)) children.set(s.parent_id, []);
      children.get(s.parent_id).push(s);
    }
    const result = [],
      seen = new Set();
    const visit = (parent) => {
      for (const s of children.get(parent) || []) {
        if (seen.has(s.id)) throw new Fault("章节循环");
        seen.add(s.id);
        result.push(this.sectionView(s));
        visit(s.id);
      }
    };
    visit(null);
    if (result.length !== all.length) throw new Fault("存在孤立章节");
    return result;
  }
  manifest() {
    this.require();
    const d = this.repo.document();
    return {
      ...this.project,
      path: this.dir,
      sections: this.listSections(),
      styles: JSON.parse(d.styles),
      warnings: JSON.parse(d.warnings),
      original: d.original || undefined,
    };
  }
  readSection(id) {
    const s = this.sectionRow(id);
    return {
      ...this.sectionView(s, true),
      blocks: this.repo.blocks(id).map((b) => this.blockView(b)),
    };
  }
  // Explicit full read for export/validation only. No editing path calls snapshot().
  snapshot(sectionIds) {
    const p = this.manifest();
    if (sectionIds?.some((id) => !p.sections.some((s) => s.id === id)))
      throw new Fault("导出章节不存在");
    p.sections = p.sections
      .filter((s) => !sectionIds?.length || sectionIds.includes(s.id))
      .map((s) => this.readSection(s.id));
    const included = new Set(p.sections.map((s) => s.id));
    for (const s of p.sections) {
      if (!included.has(s.parentId)) s.parentId = null;
      s.entries = s.entries.filter(
        (e) => e.kind === "block" || included.has(e.id),
      );
    }
    p.rootEntries = p.sections
      .filter((s) => s.parentId === null)
      .map((s) => ({ kind: "section", id: s.id }));
    return p;
  }
  node(input, { fresh = false } = {}) {
    const nodes =
      input.node || input.content
        ? [input.node || input.content]
        : fromMarkdown(input.markdown ?? "");
    if (
      nodes.length !== 1 ||
      !nodes[0] ||
      [
        "doc",
        "text",
        "tableRow",
        "tableCell",
        "tableHeader",
        "hardBreak",
        "listItem",
      ].includes(nodes[0].type)
    )
      throw new Fault("块必须恰好包含一个顶层内容节点");
    const n = semanticNode(nodes[0], { fresh });
    for (const ref of assetRefs(n))
      if (!fs.existsSync(path.join(this.dir, ref)))
        throw new Fault("图片资源不存在：" + ref);
    return n;
  }
  capture(kind, id) {
    const m = this.frame.before[kind];
    if (!m.has(id))
      m.set(
        id,
        kind === "blocks"
          ? this.repo.block(id) || null
          : this.repo.section(id) || null,
      );
  }
  putBlock(b) {
    this.capture("blocks", b.id);
    this.repo.putBlock(b);
  }
  putSection(s) {
    this.capture("sections", s.id);
    this.repo.putSection(s);
  }
  touchSection(id) {
    while (id) {
      const s = this.sectionRow(id);
      if (!this.frame.touched.has(id)) {
        this.putSection({ ...s, revision: this.repo.nextRevision(id) });
        this.frame.touched.add(id);
      }
      id = s.parent_id;
    }
  }
  commit(operation, fn) {
    this.require();
    let envelope;
    this.repo.transaction(() => {
      this.frame = {
        before: { blocks: new Map(), sections: new Map() },
        touched: new Set(),
        idMap: {},
        extra: {},
      };
      try {
        fn();
        const d = this.repo.document(),
          revision = d.revision + 1,
          timestamp = new Date().toISOString(),
          id = uid();
        this.repo.run(
          "UPDATE documents SET revision=?,updated_at=?",
          revision,
          timestamp,
        );
        const before = {},
          after = {};
        for (const kind of ["blocks", "sections"]) {
          before[kind] = [...this.frame.before[kind].entries()].map(
            ([id, row]) => ({ id, row }),
          );
          after[kind] = before[kind].map(({ id }) => ({
            id,
            row:
              (kind === "blocks"
                ? this.repo.block(id)
                : this.repo.section(id)) || null,
          }));
        }
        const sectionViews = after.sections
          .filter((x) => x.row)
          .map((x) => this.sectionView(x.row, true));
        const blockLevels = Object.fromEntries(
          after.blocks
            .filter((x) => x.row?.type === "heading")
            .map((x) => [x.id, this.level(this.sectionRow(x.row.section_id))]),
        );
        const deletedBlockRevisions = Object.fromEntries(
          after.blocks
            .filter((x) => !x.row)
            .map((x) => [
              x.id,
              this.repo.get(
                "SELECT revision FROM revision_heads WHERE id=?",
                x.id,
              ).revision,
            ]),
        );
        const deletedSectionRevisions = Object.fromEntries(
          after.sections
            .filter((x) => !x.row)
            .map((x) => [
              x.id,
              this.repo.get(
                "SELECT revision FROM revision_heads WHERE id=?",
                x.id,
              ).revision,
            ]),
        );
        const record = {
          id,
          revision,
          operation,
          timestamp,
          before,
          after,
          sectionViews,
          blockLevels,
          deletedBlockRevisions,
          deletedSectionRevisions,
          idMap: this.frame.idMap,
          ...this.frame.extra,
        };
        this.repo.run(
          "INSERT INTO change_log VALUES(?,?,?,?,?)",
          id,
          revision,
          operation,
          timestamp,
          JSON.stringify(record),
        );
        envelope = this.envelope(record);
      } finally {
        this.frame = null;
      }
    });
    for (const listener of this.listeners) {
      try {
        listener(envelope);
      } catch {}
    }
    return envelope;
  }
  envelope(record, sectionId = null) {
    const { id, revision, operation, timestamp, after } = record;
    const result = {
      id,
      changeId: id,
      revision,
      documentRevision: revision,
      operation,
      timestamp,
      changedBlocks: after.blocks
        .filter((x) => x.row && (!sectionId || x.row.section_id === sectionId))
        .map((x) => {
          const b = this.blockView(x.row);
          if (record.blockLevels?.[x.id]) {
            b.node.attrs.level = record.blockLevels[x.id];
            b.markdown = markdown(b.node);
          }
          return b;
        }),
      changedSections: (record.sectionViews || []).map((s) => {
        if (!sectionId || s.id === sectionId) return s;
        const { blockIds, entries, ...summary } = s;
        return summary;
      }),
      deletedBlockIds: after.blocks.filter((x) => !x.row).map((x) => x.id),
      deletedSectionIds: after.sections.filter((x) => !x.row).map((x) => x.id),
      deletedBlockRevisions: record.deletedBlockRevisions || {},
      idMap: record.idMap || {},
    };
    result.movedBlocks = after.blocks
      .filter((x) => x.row)
      .flatMap((x) => {
        const old = record.before.blocks.find((b) => b.id === x.id)?.row;
        return old && old.section_id !== x.row.section_id
          ? [
              {
                id: x.id,
                fromSectionId: old.section_id,
                toSectionId: x.row.section_id,
                revision: x.row.revision,
              },
            ]
          : [];
      });
    if (sectionId)
      result.removedFromSectionBlockIds = result.movedBlocks
        .filter((b) => b.fromSectionId === sectionId)
        .map((b) => b.id);
    if (record.createdBlockId)
      result.block = result.changedBlocks.find(
        (b) => b.id === record.createdBlockId,
      );
    if (record.createdSectionId)
      result.section = result.changedSections.find(
        (s) => s.id === record.createdSectionId,
      );
    if (record.styles) result.styles = record.styles;
    return result;
  }
  getChanges({ since_revision = 0, limit = 100, section_id = null } = {}) {
    this.require();
    const revision = this.project.revision;
    if (
      !Number.isInteger(since_revision) ||
      since_revision < 0 ||
      since_revision > revision
    )
      throw new Fault("变更游标无效", 409);
    limit = Math.max(1, Math.min(500, Number(limit) || 100));
    const rows = this.repo.all(
        "SELECT data FROM change_log WHERE revision>? ORDER BY revision LIMIT ?",
        since_revision,
        limit + 1,
      ),
      first = this.repo.get("SELECT MIN(revision) n FROM change_log").n;
    const changes = rows
      .slice(0, limit)
      .map((r) => this.envelope(JSON.parse(r.data), section_id));
    return {
      revision,
      changes,
      hasMore: rows.length > limit,
      nextRevision: changes.at(-1)?.revision || revision,
      resetRequired:
        since_revision > 0 && first !== null && since_revision < first - 1,
    };
  }
  position(parent, beforeId = null, afterId = null, excluding = null) {
    const entries = this.repo.entries(parent).filter((x) => x.id !== excluding);
    let index = entries.length;
    if (beforeId) {
      index = entries.findIndex((x) => x.id === beforeId);
      if (index < 0) throw new Fault("插入锚点不在目标章节");
    } else if (afterId) {
      index = entries.findIndex((x) => x.id === afterId);
      if (index < 0) throw new Fault("插入锚点不在目标章节");
      index++;
    }
    if (
      parent &&
      index === 0 &&
      entries[0]?.id === this.sectionRow(parent).heading_block_id
    )
      throw new Fault("不能放在章节标题之前");
    const previous = entries[index - 1]?.position,
      next = entries[index]?.position;
    if (previous === undefined) return (next ?? 1024) - 1024;
    if (next === undefined) return previous + 1024;
    if (next - previous > 1e-7) return (previous + next) / 2;
    entries.forEach((e, i) => {
      const row =
        e.kind === "block" ? this.blockRow(e.id) : this.sectionRow(e.id);
      if (e.kind === "block") this.putBlock({ ...row, position: i * 1024 });
      else this.putSection({ ...row, position: i * 1024 });
    });
    return index * 1024 - 512;
  }
  updateBlock(a) {
    const b = this.blockRow(a.block_id);
    expect(b.revision, a.expected_revision);
    const n = a.replace
      ? semanticNode(replaceText(JSON.parse(b.content), a.old_text, a.new_text))
      : this.node(a);
    if (
      this.sectionRow(b.section_id).heading_block_id === b.id &&
      n.type !== "heading"
    )
      throw new Fault("章节标题必须保持 Heading 类型");
    this.putBlock({
      ...b,
      type: n.type,
      content: JSON.stringify(n),
      revision: this.repo.nextRevision(b.id),
    });
    this.touchSection(b.section_id);
  }
  createBlock(a) {
    const s = this.sectionRow(a.section_id);
    expect(s.revision, a.expected_revision);
    const id = uid(),
      n = this.node(a, { fresh: true });
    this.putBlock({
      id,
      section_id: s.id,
      position: this.position(s.id, a.before_id, a.after_id),
      type: n.type,
      content: JSON.stringify(n),
      revision: 1,
    });
    this.touchSection(s.id);
    this.frame.extra.createdBlockId = id;
    return id;
  }
  deleteBlock(a) {
    const b = this.blockRow(a.block_id);
    expect(b.revision, a.expected_revision);
    if (this.sectionRow(b.section_id).heading_block_id === b.id)
      throw new Fault("请删除章节来删除其标题");
    this.capture("blocks", b.id);
    this.repo.head(b.id, b.revision + 1);
    this.repo.run("DELETE FROM blocks WHERE id=?", b.id);
    this.touchSection(b.section_id);
  }
  moveBlock(a) {
    const b = this.blockRow(a.block_id),
      dest = this.sectionRow(a.section_id);
    expect(b.revision, a.expected_revision);
    expect(dest.revision, a.target_revision);
    if (this.sectionRow(b.section_id).heading_block_id === b.id)
      throw new Fault("标题跟随章节移动");
    if (a.before_id === b.id || a.after_id === b.id)
      throw new Fault("不能相对自身移动");
    this.putBlock({
      ...b,
      section_id: dest.id,
      position: this.position(dest.id, a.before_id, a.after_id, b.id),
      revision: this.repo.nextRevision(b.id),
    });
    this.touchSection(b.section_id);
    this.touchSection(dest.id);
  }
  saveBlocks(a) {
    const s = this.sectionRow(a.section_id),
      structural = Array.isArray(a.order);
    if (
      !structural &&
      ["created", "deleted", "base_ids", "section_revision"].some(
        (k) => a[k] !== undefined,
      )
    )
      throw new Fault("结构增量必须同时提供 order/base_ids/section_revision");
    if (structural) {
      expect(s.revision, a.section_revision);
      if (
        JSON.stringify(this.repo.blocks(s.id).map((b) => b.id)) !==
        JSON.stringify(a.base_ids)
      )
        throw new Fault("章节结构已变化", 409);
    }
    const seen = new Set();
    for (const edit of a.changed || []) {
      if (seen.has(edit.block_id)) throw new Fault("同一块不能重复提交");
      seen.add(edit.block_id);
      if (this.blockRow(edit.block_id).section_id !== s.id)
        throw new Fault("内容块已移出当前章节", 409);
      this.updateBlock(edit);
    }
    if (!structural) return;
    const oldPlacements = new Map(
      this.repo.blocks(s.id).map((b) => [b.id, b.position]),
    );
    for (const deletion of a.deleted || []) {
      if (this.blockRow(deletion.block_id).section_id !== s.id)
        throw new Fault("待删块不属于当前章节", 409);
      this.deleteBlock(deletion);
    }
    for (const creation of a.created || []) {
      if (!creation.temporary_id || this.frame.idMap[creation.temporary_id])
        throw new Fault("新增块临时 ID 缺失或重复");
      if (
        this.repo.block(creation.temporary_id) ||
        this.repo.section(creation.temporary_id)
      )
        throw new Fault("临时 ID 与现有对象冲突");
      if (creation.restore_id) {
        const id = creation.restore_id,
          head = this.repo.get(
            "SELECT revision FROM revision_heads WHERE id=?",
            id,
          );
        if (!head || this.repo.block(id) || this.repo.section(id))
          throw new Fault("只能恢复已删除的历史块", 409);
        expect(head.revision, creation.expected_deleted_revision);
        // The last deletion must identify this ID as a block, not a removed Section.
        const deleted = this.repo.get(
          "SELECT data FROM change_log WHERE json_type(data, '$.deletedBlockRevisions.' || ?) IS NOT NULL ORDER BY revision DESC LIMIT 1",
          '"' + id + '"',
        );
        if (!deleted) throw new Fault("缺少原内容块删除记录", 409);
        const n = this.node(creation);
        this.putBlock({
          id,
          section_id: s.id,
          position: this.position(s.id),
          type: n.type,
          content: JSON.stringify(n),
          revision: head.revision + 1,
        });
        this.frame.idMap[creation.temporary_id] = id;
      } else
        this.frame.idMap[creation.temporary_id] = this.createBlock({
          ...creation,
          section_id: s.id,
          expected_revision: this.sectionRow(s.id).revision,
        });
    }
    const ids = a.order.map((id) => this.frame.idMap[id] || id),
      current = this.repo.blocks(s.id);
    if (
      new Set(ids).size !== ids.length ||
      ids.length !== current.length ||
      current.some((b) => !ids.includes(b.id))
    )
      throw new Fault("块顺序不完整或重复");
    if (ids[0] !== s.heading_block_id) throw new Fault("章节标题必须位于最前");
    // Keep surviving slots around child sections. Deletion must never pull a tail
    // block into a deleted block's slot on the other side of a child chapter.
    const existing = ids.filter((id) => oldPlacements.has(id)),
      slots = existing.map((id) => oldPlacements.get(id)).sort((a, b) => a - b);
    existing.forEach((id, i) => {
      const b = this.blockRow(id),
        position = slots[i];
      if (b.position !== position)
        this.putBlock({
          ...b,
          position,
          revision: this.frame.before.blocks.has(id)
            ? b.revision
            : this.repo.nextRevision(id),
        });
    });
    ids.forEach((id, i) => {
      if (oldPlacements.has(id)) return;
      const next = ids.slice(i + 1).find((nextId) => oldPlacements.has(nextId));
      const position = next
        ? this.position(s.id, next, null, id)
        : this.position(s.id, null, i ? ids[i - 1] : null, id);
      const b = this.blockRow(id);
      this.putBlock({ ...b, position });
    });
    this.touchSection(s.id);
  }
  legacySave(a, replace = false) {
    const s = this.readSection(a.section_id),
      nodes = a.nodes || fromMarkdown(a.markdown ?? "");
    const baseIds = replace ? s.blocks.map((b) => b.id) : a.base_ids,
      desired = nodes.map((n) => n.attrs?.id || uid());
    const structural =
        replace || JSON.stringify(desired) !== JSON.stringify(baseIds),
      edits = replace ? nodes : a.changed || [],
      changed = [],
      created = [];
    edits.forEach((n) => {
      const id = n.attrs?.id || desired[nodes.indexOf(n)],
        old = s.blocks.find((b) => b.id === id);
      if (old)
        changed.push({
          block_id: id,
          expected_revision: replace ? old.revision : a.versions[id],
          node: n,
        });
      else created.push({ temporary_id: id, node: n });
    });
    if (replace) expect(s.revision, a.expected_revision);
    if (replace && !desired.includes(s.headingBlockId)) {
      if (nodes[0]?.type === "heading") {
        const first = desired[0];
        desired[0] = s.headingBlockId;
        const i = created.findIndex((c) => c.temporary_id === first);
        if (i >= 0) created.splice(i, 1);
        changed.push({
          block_id: s.headingBlockId,
          expected_revision: s.blocks[0].revision,
          node: nodes[0],
        });
      } else desired.unshift(s.headingBlockId);
    }
    this.saveBlocks({
      section_id: s.id,
      changed,
      ...(structural
        ? {
            order: desired,
            base_ids: baseIds,
            section_revision: replace ? s.revision : a.section_revision,
            created,
            deleted: s.blocks
              .filter((b) => !desired.includes(b.id))
              .map((b) => ({
                block_id: b.id,
                expected_revision: replace ? b.revision : a.versions[b.id],
              })),
          }
        : {}),
    });
  }
  createSection(a) {
    expect(this.project.revision, a.expected_revision);
    const parent = a.parent_id || null;
    if (parent) this.sectionRow(parent);
    const id = uid(),
      headingId = uid(),
      n = semanticNode({
        type: "heading",
        content: [{ type: "text", text: a.title || "新章节" }],
      });
    this.putSection({
      id,
      parent_id: parent,
      heading_block_id: headingId,
      position: this.position(parent, a.before_id, a.after_id),
      revision: 1,
    });
    this.putBlock({
      id: headingId,
      section_id: id,
      position: -1024,
      type: "heading",
      content: JSON.stringify(n),
      revision: 1,
    });
    if (parent) this.touchSection(parent);
    this.frame.extra.createdSectionId = id;
    return id;
  }
  descendants(id) {
    return this.repo
      .all(
        "WITH RECURSIVE subtree(id) AS (SELECT id FROM sections WHERE id=? UNION ALL SELECT s.id FROM sections s JOIN subtree t ON s.parent_id=t.id) SELECT id FROM subtree",
        id,
      )
      .map((s) => s.id);
  }
  moveSection(a) {
    const s = this.sectionRow(a.section_id);
    expect(s.revision, a.expected_revision);
    const parent = a.parent_id || null;
    if (parent) this.sectionRow(parent);
    if (parent && this.descendants(s.id).includes(parent))
      throw new Fault("不能移动到自身或子章节");
    if (a.target_revision !== undefined && parent)
      expect(this.sectionRow(parent).revision, a.target_revision);
    if (a.before_id === s.id || a.after_id === s.id)
      throw new Fault("不能相对自身移动");
    this.putSection({
      ...s,
      parent_id: parent,
      position: this.position(parent, a.before_id, a.after_id, s.id),
      revision: this.repo.nextRevision(s.id),
    });
    this.frame.touched.add(s.id);
    for (const id of this.descendants(s.id)) this.capture("sections", id);
    if (s.parent_id) this.touchSection(s.parent_id);
    if (parent) this.touchSection(parent);
  }
  deleteSection(a) {
    const s = this.sectionRow(a.section_id);
    expect(s.revision, a.expected_revision);
    const ids = this.descendants(s.id);
    for (const id of ids) {
      for (const b of this.repo.blocks(id)) {
        this.capture("blocks", b.id);
        this.repo.head(b.id, b.revision + 1);
        this.repo.run("DELETE FROM blocks WHERE id=?", b.id);
      }
      this.capture("sections", id);
      this.repo.head(id, this.sectionRow(id).revision + 1);
    }
    for (const id of ids.reverse())
      this.repo.run("DELETE FROM sections WHERE id=?", id);
    if (s.parent_id) this.touchSection(s.parent_id);
  }
  copySection(a) {
    const s = this.sectionRow(a.section_id);
    expect(s.revision, a.expected_revision);
    const target =
      a.parent_id === undefined ? s.parent_id : a.parent_id || null;
    if (target) {
      const p = this.sectionRow(target);
      if (a.target_revision !== undefined)
        expect(p.revision, a.target_revision);
    }
    const ids = this.descendants(s.id),
      copies = new Map(ids.map((id) => [id, uid()]));
    for (const id of ids) {
      const old = this.sectionRow(id),
        blocks = this.repo.blocks(id),
        blockIds = new Map(blocks.map((b) => [b.id, uid()]));
      this.putSection({
        ...old,
        id: copies.get(id),
        parent_id: id === s.id ? target : copies.get(old.parent_id),
        heading_block_id: blockIds.get(old.heading_block_id),
        position:
          id === s.id
            ? this.position(target, a.before_id, a.after_id)
            : old.position,
        revision: 1,
      });
      for (const b of blocks)
        this.putBlock({
          ...b,
          id: blockIds.get(b.id),
          section_id: copies.get(id),
          content: JSON.stringify(
            semanticNode(JSON.parse(b.content), { fresh: true }),
          ),
          revision: 1,
        });
    }
    if (target) this.touchSection(target);
    this.frame.extra.createdSectionId = copies.get(s.id);
  }
  undo(a) {
    expect(this.project.revision, a.expected_revision);
    const r = this.repo.get(
      "SELECT data FROM change_log WHERE id=?",
      a.change_id,
    );
    if (!r) throw new Fault("变更不存在", 404);
    const record = JSON.parse(r.data);
    if (record.styles) throw new Fault("请使用样式模板更新恢复模板");
    for (const kind of ["blocks", "sections"])
      for (const x of record.after[kind]) {
        const current =
          kind === "blocks" ? this.repo.block(x.id) : this.repo.section(x.id);
        if (
          !current !== !x.row ||
          (current && current.revision !== x.row.revision)
        )
          throw new Fault("变更对象已有后续修改，不能撤销", 409);
        if (!x.row) {
          const revisions =
            kind === "blocks"
              ? record.deletedBlockRevisions
              : record.deletedSectionRevisions;
          const tombstone =
            revisions?.[x.id] ??
            record.before[kind].find((b) => b.id === x.id)?.row?.revision + 1;
          expect(
            this.repo.get(
              "SELECT revision FROM revision_heads WHERE id=?",
              x.id,
            )?.revision,
            tombstone,
          );
        }
      }
    for (const x of record.before.sections) {
      this.capture("sections", x.id);
      if (x.row)
        this.repo.putSection({
          ...x.row,
          revision: this.repo.nextRevision(x.id),
        });
    }
    for (const x of record.before.blocks) {
      this.capture("blocks", x.id);
      if (x.row)
        this.repo.putBlock({
          ...x.row,
          revision: this.repo.nextRevision(x.id),
        });
      else {
        this.repo.head(x.id, this.repo.nextRevision(x.id));
        this.repo.run("DELETE FROM blocks WHERE id=?", x.id);
      }
    }
    for (const x of record.before.sections.filter((x) => !x.row).reverse()) {
      this.repo.head(x.id, this.repo.nextRevision(x.id));
      this.repo.run("DELETE FROM sections WHERE id=?", x.id);
    }
  }
  apply(name, a = {}) {
    this.require();
    if (a.project_id !== undefined && a.project_id !== this.project.id)
      throw new Fault("活动项目已变化", 409);
    if (name === "project_info")
      return {
        ...this.project,
        path: this.dir,
        sectionCount: this.repo.get("SELECT COUNT(*) n FROM sections").n,
        warnings: JSON.parse(this.repo.document().warnings),
      };
    if (name === "list_sections") return this.listSections();
    if (name === "read_section") return this.readSection(a.section_id);
    if (name === "read_sections")
      return (a.section_ids || []).map((id) => this.readSection(id));
    if (name === "read_block") return this.blockView(this.blockRow(a.block_id));
    if (name === "list_blocks")
      return this.repo.blocks(this.sectionRow(a.section_id).id).map((b) => {
        const view = this.blockView(b);
        return {
          id: b.id,
          type: b.type,
          sectionId: b.section_id,
          order: b.position,
          revision: b.revision,
          markdown: view.markdown,
        };
      });
    if (name === "get_changes") return this.getChanges(a);
    return this.commit(name, () => {
      if (name === "update_block") return this.updateBlock(a);
      if (name === "replace_text")
        return this.updateBlock({ ...a, replace: true });
      if (name === "create_block" || name === "insert_block")
        return this.createBlock(a);
      if (name === "delete_block") return this.deleteBlock(a);
      if (name === "move_block") return this.moveBlock(a);
      if (name === "copy_block") {
        const b = this.blockRow(a.block_id);
        expect(b.revision, a.expected_revision);
        const target = a.section_id || b.section_id;
        return this.createBlock({
          ...a,
          section_id: target,
          expected_revision:
            a.target_revision ?? this.sectionRow(target).revision,
          node: JSON.parse(b.content),
        });
      }
      if (name === "save_blocks") return this.saveBlocks(a);
      if (name === "save_section") return this.legacySave(a);
      if (name === "write_section") return this.legacySave(a, true);
      if (name === "create_section" || name === "add_section")
        return this.createSection(a);
      if (name === "update_section") {
        const s = this.sectionRow(a.section_id);
        expect(s.revision, a.expected_revision);
        if (typeof a.title !== "string") throw new Fault("请提供章节标题");
        const b = this.blockRow(s.heading_block_id);
        return this.updateBlock({
          block_id: b.id,
          expected_revision: b.revision,
          node: {
            type: "heading",
            content: a.title ? [{ type: "text", text: a.title }] : [],
          },
        });
      }
      if (name === "move_section") return this.moveSection(a);
      if (name === "delete_section") return this.deleteSection(a);
      if (name === "copy_section") return this.copySection(a);
      if (name === "undo_change") return this.undo(a);
      if (name === "styles") {
        expect(this.project.revision, a.expected_revision);
        const styles = exportStyles(a.styles);
        this.repo.run("UPDATE documents SET styles=?", JSON.stringify(styles));
        this.frame.extra.styles = styles;
        return;
      }
      throw new Fault("未知操作 " + name);
    });
  }
  addAsset(bytes, name) {
    this.require();
    const ext = path.extname(name).toLowerCase();
    if (
      ![
        ".png",
        ".jpg",
        ".jpeg",
        ".gif",
        ".webp",
        ".bmp",
        ".emf",
        ".wmf",
        ".svg",
      ].includes(ext)
    )
      throw new Fault("不支持的图片类型");
    const src = "assets/" + uid() + ext;
    atomic(path.join(this.dir, src), bytes);
    this.repo.transaction(() =>
      this.repo.run(
        "INSERT INTO assets VALUES(?,?,?)",
        src,
        ext.slice(1),
        bytes.length,
      ),
    );
    return { src };
  }
  async export(sectionIds) {
    const p = this.snapshot(sectionIds),
      base = this.dir,
      zip = new JSZip();
    zip.file(
      "structure.json",
      JSON.stringify({ ...p, path: undefined }, null, 2),
    );
    const blocks = new Map(
        p.sections.flatMap((s) => s.blocks).map((b) => [b.id, b]),
      ),
      sections = new Map(p.sections.map((s) => [s.id, s])),
      ordered = [];
    const visit = (entries) => {
      for (const e of entries)
        if (e.kind === "block") ordered.push(blocks.get(e.id));
        else visit(sections.get(e.id)?.entries || []);
    };
    visit(p.rootEntries);
    zip.file(
      "document.md",
      ordered
        .filter(Boolean)
        .map((b) => b.markdown)
        .join("\n\n"),
    );
    zip.file("styles.json", JSON.stringify(p.styles, null, 2));
    zip.file("export-rules.md", EXPORT_RULES);
    zip.file(
      "word-prompt.txt",
      "本内容包保留为兼容入口；可直接使用 export_document 生成 DOCX。",
    );
    for (const f of fs.readdirSync(path.join(base, "assets")))
      if (fs.statSync(path.join(base, "assets", f)).isFile())
        zip.file("assets/" + f, fs.readFileSync(path.join(base, "assets", f)));
    if (p.original && fs.existsSync(path.join(base, p.original)))
      zip.file(
        "original/source.docx",
        fs.readFileSync(path.join(base, p.original)),
      );
    return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  }
  async exportDocx(sectionIds) {
    const p = this.snapshot(sectionIds),
      base = this.dir,
      { exportDocx } = await import("./docx-export.js");
    return exportDocx(p, {
      assetReader: (ref) => {
        if (!/^assets\/[\w.-]+$/.test(ref)) throw new Fault("非法图片引用");
        return fs.readFileSync(path.join(base, ref));
      },
      template: p.styles,
    });
  }
}
export const EXPORT_RULES =
  "# Word 导出\n\n正文以结构化块为准；Section 与 Block 的稳定 ID 和 entries 顺序为权威。styles.json 只负责输出排版，不属于正文。无法转换的复杂 Word 内容应对照 warnings 和归档原件；禁止默默丢弃正文。\n";
