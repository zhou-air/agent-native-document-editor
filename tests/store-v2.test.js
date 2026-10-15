import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Store } from "../src/store.js";
import { SqliteRepository } from "../src/repository.js";
import { semanticNode } from "../src/model.js";
import { plain } from "../src/content.js";

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentdoc-store-v2-")),
    store = new Store();
  const manifest = store.create(dir, "测试文档");
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    store,
    dir,
    manifest,
    section: store.readSection(manifest.sections[0].id),
  };
}
const update = (s, b, text) =>
  s.apply("update_block", {
    block_id: b.id,
    expected_revision: b.revision,
    markdown: text,
  });
const section = (s, title, parent_id = null) =>
  s.apply("create_section", {
    title,
    parent_id,
    expected_revision: s.project.revision,
  }).section;

test("block/section identities survive content, title, move and restart; copies have new IDs", (t) => {
  const { store: s, dir, section: a } = setup(t),
    b = a.blocks[1];
  const edited = update(s, b, "**changed**").changedBlocks[0];
  assert.equal(edited.id, b.id);
  assert.equal(edited.revision, 2);
  s.apply("update_section", {
    section_id: a.id,
    expected_revision: s.sectionRow(a.id).revision,
    title: "改名",
  });
  assert.equal(s.readSection(a.id).headingBlockId, a.headingBlockId);
  const dest = section(s, "目标");
  s.apply("move_block", {
    block_id: b.id,
    expected_revision: edited.revision,
    section_id: dest.id,
    target_revision: dest.revision,
  });
  const moved = s.apply("read_block", { block_id: b.id });
  assert.equal(moved.sectionId, dest.id);
  const copy = s.apply("copy_block", {
    block_id: b.id,
    expected_revision: moved.revision,
    section_id: a.id,
    target_revision: s.sectionRow(a.id).revision,
  }).block;
  assert.notEqual(copy.id, b.id);
  assert.equal(plain(copy.node), "changed");
  s.close();
  s.open(dir);
  assert.equal(s.apply("read_block", { block_id: b.id }).sectionId, dest.id);
  assert.equal(s.readSection(a.id).title, "改名");
});

test("one edit never calls snapshot/listSections or rewrites a project JSON; idle does no write", (t) => {
  const { store: s, dir, section: a } = setup(t);
  s.snapshot = () => {
    throw Error("unexpected full snapshot");
  };
  s.listSections = () => {
    throw Error("unexpected tree reload");
  };
  const result = update(s, a.blocks[1], "局部");
  assert.equal(result.changedBlocks.length, 1);
  assert.equal(result.sections, undefined);
  assert(!fs.existsSync(path.join(dir, "project.json")));
  assert(!fs.existsSync(path.join(dir, "styles.json")));
  const count = s.repo.get("SELECT COUNT(*) n FROM change_log").n;
  for (let i = 0; i < 50; i++)
    assert.deepEqual(
      s.apply("get_changes", { since_revision: s.project.revision }).changes,
      [],
    );
  assert.equal(s.repo.get("SELECT COUNT(*) n FROM change_log").n, count);
});

test("multiple agents merge different blocks and stale batch is fully rolled back", (t) => {
  const { store: s, section: a } = setup(t);
  const b = s.apply("create_block", {
    section_id: a.id,
    expected_revision: a.revision,
    markdown: "second",
  }).block;
  update(s, a.blocks[1], "agent A");
  update(s, b, "agent B");
  const first = s.apply("read_block", { block_id: a.blocks[1].id }),
    revision = s.project.revision;
  assert.throws(
    () =>
      s.apply("save_blocks", {
        section_id: a.id,
        changed: [
          {
            block_id: first.id,
            expected_revision: first.revision,
            markdown: "must rollback",
          },
          { block_id: b.id, expected_revision: b.revision, markdown: "stale" },
        ],
      }),
    (e) => e.code === 409,
  );
  assert.equal(
    plain(s.apply("read_block", { block_id: first.id }).node),
    "agent A",
  );
  assert.equal(s.project.revision, revision);
});

test("section subtree moves, copies and deletes atomically, cycle attempts roll back", (t) => {
  const { store: s, section: a } = setup(t),
    b = section(s, "子节", a.id),
    c = section(s, "孙节", b.id),
    d = section(s, "另章");
  const ids = s.snapshot().sections.flatMap((s) => s.blocks.map((b) => b.id));
  s.apply("move_section", {
    section_id: a.id,
    expected_revision: s.sectionRow(a.id).revision,
    parent_id: d.id,
  });
  assert.equal(s.readSection(c.id).level, 4);
  assert.deepEqual(
    new Set(s.snapshot().sections.flatMap((s) => s.blocks.map((b) => b.id))),
    new Set(ids),
  );
  const rev = s.project.revision;
  assert.throws(() =>
    s.apply("move_section", {
      section_id: d.id,
      expected_revision: s.sectionRow(d.id).revision,
      parent_id: c.id,
    }),
  );
  assert.equal(s.project.revision, rev);
  const copied = s.apply("copy_section", {
    section_id: a.id,
    expected_revision: s.sectionRow(a.id).revision,
    parent_id: null,
  }).section;
  assert.equal(s.descendants(copied.id).length, 3);
  assert(s.repo.blocks(copied.id).every((b) => !ids.includes(b.id)));
  const del = s.apply("delete_section", {
    section_id: a.id,
    expected_revision: s.sectionRow(a.id).revision,
  });
  assert.equal(del.deletedSectionIds.length, 3);
  assert(s.repo.section(copied.id));
  s.apply("undo_change", {
    change_id: del.changeId,
    expected_revision: s.project.revision,
  });
  assert(s.repo.section(c.id));
  assert.equal(s.repo.section(a.id).parent_id, d.id);
});

test("ancestor revision prevents deleting a subtree with an unseen descendant edit", (t) => {
  const { store: s, section: a } = setup(t),
    b = section(s, "子", a.id),
    prior = s.sectionRow(a.id).revision;
  s.apply("update_section", {
    section_id: b.id,
    expected_revision: b.revision,
    title: "remote",
  });
  assert.throws(
    () =>
      s.apply("delete_section", { section_id: a.id, expected_revision: prior }),
    (e) => e.code === 409,
  );
  assert(s.repo.section(b.id));
});

test("mixed section/block placement has deterministic order and server allocates structural IDs", (t) => {
  const { store: s, section: a } = setup(t),
    child = section(s, "child", a.id),
    old = s.readSection(a.id);
  const tail = s.apply("create_block", {
    section_id: a.id,
    expected_revision: old.revision,
    markdown: "after child",
  }).block;
  assert.deepEqual(
    s.readSection(a.id).entries.map((e) => e.id),
    [a.headingBlockId, a.blocks[1].id, child.id, tail.id],
  );
  const current = s.readSection(a.id),
    temp = "client-draft-id";
  const saved = s.apply("save_blocks", {
    section_id: a.id,
    section_revision: current.revision,
    base_ids: current.blockIds,
    changed: [],
    created: [
      {
        temporary_id: temp,
        node: { type: "paragraph", content: [{ type: "text", text: "new" }] },
      },
    ],
    deleted: [],
    order: [...current.blockIds, temp],
  });
  assert.match(saved.idMap[temp], /^[0-9a-f-]{36}$/);
  assert.notEqual(saved.idMap[temp], temp);
  assert.deepEqual(
    s
      .readSection(a.id)
      .entries.slice(0, 4)
      .map((e) => e.id),
    [a.headingBlockId, a.blocks[1].id, child.id, tail.id],
  );
});

test("structure conflict and malformed structural batch leave no half-created objects", (t) => {
  const { store: s, section: a } = setup(t),
    rev = s.project.revision;
  assert.throws(() =>
    s.apply("save_blocks", {
      section_id: a.id,
      section_revision: a.revision,
      base_ids: a.blockIds,
      changed: [],
      created: [
        { temporary_id: "new", node: { type: "paragraph", content: [] } },
      ],
      deleted: [],
      order: ["new", ...a.blockIds],
    }),
  );
  assert.equal(s.project.revision, rev);
  assert.equal(s.readSection(a.id).blocks.length, 2);
  assert.throws(() =>
    s.apply("delete_block", {
      block_id: a.headingBlockId,
      expected_revision: 1,
    }),
  );
});

test("saved deletion can be undone by exact tombstone revision without changing block ID", (t) => {
  const { store: s, section: a } = setup(t),
    original = a.blocks[1];
  const removed = s.apply("delete_block", {
    block_id: original.id,
    expected_revision: original.revision,
  });
  const current = s.readSection(a.id),
    deletedRevision = removed.deletedBlockRevisions[original.id];
  const args = {
    section_id: a.id,
    section_revision: current.revision,
    base_ids: current.blockIds,
    changed: [],
    deleted: [],
    order: [...current.blockIds, original.id],
    created: [
      {
        temporary_id: original.id,
        restore_id: original.id,
        expected_deleted_revision: deletedRevision,
        node: original.node,
      },
    ],
  };
  const restored = s.apply("save_blocks", args);
  assert.equal(restored.idMap[original.id], original.id);
  assert.equal(s.blockRow(original.id).revision, deletedRevision + 1);
  assert.equal(
    plain(s.apply("read_block", { block_id: original.id }).node),
    plain(original.node),
  );
  assert.throws(
    () => s.apply("save_blocks", args),
    (e) => e.code === 409,
  );
});

test("incremental replay is historical, paginated, durable and does not expose whole document", (t) => {
  const { store: s, dir, section: a } = setup(t),
    first = s.apply("update_section", {
      section_id: a.id,
      expected_revision: a.revision,
      title: "First",
    });
  s.apply("update_section", {
    section_id: a.id,
    expected_revision: s.sectionRow(a.id).revision,
    title: "Second",
  });
  s.close();
  s.open(dir);
  const page = s.apply("get_changes", { since_revision: 1, limit: 1 });
  assert.equal(page.hasMore, true);
  assert.equal(page.changes[0].changedSections[0].title, "First");
  assert.equal(page.changes[0].id, first.id);
  const next = s.apply("get_changes", {
    since_revision: page.nextRevision,
    limit: 1,
  });
  assert.equal(next.changes[0].changedSections[0].title, "Second");
  assert.equal(next.hasMore, false);
  const persisted = JSON.parse(
    s.repo.get("SELECT data FROM change_log WHERE id=?", first.id).data,
  );
  assert.equal(persisted.before.blocks.length, 1);
  assert.equal(persisted.document, undefined);
});

test("undo and redo restore content with monotonic versions, later conflict is rejected", (t) => {
  const { store: s, section: a } = setup(t),
    b = a.blocks[1],
    original = plain(b.node),
    edited = update(s, b, "new");
  const undo = s.apply("undo_change", {
    change_id: edited.changeId,
    expected_revision: s.project.revision,
  });
  assert.equal(plain(s.apply("read_block", { block_id: b.id }).node), original);
  s.apply("undo_change", {
    change_id: undo.changeId,
    expected_revision: s.project.revision,
  });
  assert.equal(plain(s.apply("read_block", { block_id: b.id }).node), "new");
  assert(s.blockRow(b.id).revision > 2);
  assert.throws(
    () =>
      s.apply("undo_change", {
        change_id: edited.changeId,
        expected_revision: s.project.revision,
      }),
    (e) => e.code === 409,
  );
});

test("legacy section tools preserve heading identity and use revision guards", (t) => {
  const { store: s, section: a } = setup(t);
  s.apply("write_section", {
    section_id: a.id,
    expected_revision: a.revision,
    markdown: "# 新标题\n\n新的正文\n\n第二段",
  });
  const after = s.readSection(a.id);
  assert.equal(after.headingBlockId, a.headingBlockId);
  assert.equal(after.blocks.length, 3);
  const nodes = after.blocks.map((b) => b.node);
  nodes[1].content[0].text = "compat edit";
  s.apply("save_section", {
    section_id: a.id,
    nodes,
    changed: [nodes[1]],
    versions: Object.fromEntries(after.blocks.map((b) => [b.id, b.revision])),
    base_ids: after.blockIds,
    section_revision: after.revision,
  });
  assert.equal(plain(s.readSection(a.id).blocks[1].node), "compat edit");
});

test("semantic boundary strips Word formatting, retains superscript/link and rejects invalid structures/assets", (t) => {
  const { store: s, section: a } = setup(t),
    b = a.blocks[1];
  const r = s.apply("update_block", {
    block_id: b.id,
    expected_revision: b.revision,
    node: {
      type: "paragraph",
      attrs: {
        id: "imposter",
        fontFamily: "Arial",
        fontSize: 99,
        xml: "<w:p/>",
      },
      content: [
        {
          type: "text",
          text: "x2",
          marks: [
            { type: "superscript" },
            { type: "link", attrs: { href: "mailto:a@example.com" } },
          ],
        },
      ],
      source: { xml: "bad" },
    },
  });
  const saved = r.changedBlocks[0];
  assert.equal(saved.id, b.id);
  assert.equal(saved.content.attrs, undefined);
  assert.equal(saved.node.content[0].marks[0].type, "superscript");
  assert.throws(() =>
    semanticNode({
      type: "paragraph",
      content: [
        {
          type: "text",
          text: "bad",
          marks: [{ type: "link", attrs: { href: "javascript:bad" } }],
        },
      ],
    }),
  );
  assert.throws(() =>
    s.apply("create_block", {
      section_id: a.id,
      expected_revision: s.sectionRow(a.id).revision,
      node: { type: "image", attrs: { src: "assets/missing.png" } },
    }),
  );
});

test("automatic migration preserves originals, semantic text/IDs/tables and validates before activation", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentdoc-v1-")),
    s = new Store();
  t.after(() => {
    s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const old = {
    formatVersion: 1,
    id: "old-document",
    title: "旧项目",
    revision: 7,
    sections: [
      {
        id: "old-section",
        title: "原题",
        parentId: null,
        revision: 3,
        blocks: [
          {
            id: "heading",
            type: "heading",
            revision: 4,
            node: {
              type: "heading",
              attrs: { id: "heading", level: 1 },
              content: [{ type: "text", text: "原题" }],
            },
          },
          {
            id: "paragraph",
            type: "paragraph",
            revision: 8,
            source: { xml: "<w:p/>" },
            node: {
              type: "paragraph",
              attrs: { id: "paragraph", fontSize: 18 },
              content: [
                {
                  type: "text",
                  text: "正文不能丢失",
                  marks: [{ type: "bold" }],
                },
              ],
            },
          },
        ],
      },
    ],
    styles: { semantic: {}, definitions: { Word: "xml" }, localOverrides: {} },
    warnings: [],
  };
  const bytes = JSON.stringify(old);
  fs.writeFileSync(path.join(dir, "project.json"), bytes);
  fs.writeFileSync(path.join(dir, "styles.json"), "original mirror");
  const manifest = s.open(dir),
    content = s.readSection("old-section");
  assert.equal(manifest.id, old.id);
  assert.equal(manifest.revision, 7);
  assert.equal(content.blocks[1].id, "paragraph");
  assert.equal(content.blocks[1].revision, 8);
  assert.equal(plain(content.blocks[1].node), "正文不能丢失");
  assert.equal(content.blocks[1].source, undefined);
  assert.equal(manifest.styles.definitions, undefined);
  const report = JSON.parse(
    fs.readFileSync(path.join(dir, "migration-report.json")),
  );
  assert(report.verified);
  assert.equal(
    fs.readFileSync(path.join(report.backup, "project.json"), "utf8"),
    bytes,
  );
  update(s, content.blocks[1], "新正文");
  assert.equal(fs.readFileSync(path.join(dir, "project.json"), "utf8"), bytes);
  assert.equal(
    fs.readFileSync(path.join(dir, "styles.json"), "utf8"),
    "original mirror",
  );
});

test("invalid old content leaves backup and does not activate a database", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentdoc-bad-v1-")),
    s = new Store();
  t.after(() => {
    s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  fs.writeFileSync(
    path.join(dir, "project.json"),
    JSON.stringify({
      formatVersion: 1,
      sections: [
        {
          id: "s",
          title: "s",
          blocks: [
            {
              id: "b",
              node: { type: "image", attrs: { src: "assets/absent.png" } },
            },
          ],
        },
      ],
    }),
  );
  assert.throws(() => s.open(dir), /图片资源缺失/);
  assert(!fs.existsSync(path.join(dir, "document.sqlite")));
  assert(fs.readdirSync(path.join(dir, "backups")).length);
});

test("SQLite process death rolls back uncommitted edit and retains committed revision", (t) => {
  const { store: s, dir, section: a } = setup(t);
  update(s, a.blocks[1], "committed");
  const revision = s.project.revision;
  s.close();
  const script = `import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(process.argv[1]);db.exec('PRAGMA journal_mode=WAL; BEGIN IMMEDIATE');db.prepare('UPDATE blocks SET content=? WHERE id=?').run(JSON.stringify({type:'paragraph',content:[{type:'text',text:'uncommitted'}]}),process.argv[2]);process.exit(19);`;
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      script,
      path.join(dir, "document.sqlite"),
      a.blocks[1].id,
    ],
    { windowsHide: true },
  );
  assert.equal(child.status, 19);
  s.open(dir);
  assert.equal(s.project.revision, revision);
  assert.equal(
    plain(s.apply("read_block", { block_id: a.blocks[1].id }).node),
    "committed",
  );
  s.repo.integrity();
});

test("second service owner cannot open the active project", (t) => {
  const { store: s, dir } = setup(t),
    second = new Store();
  t.after(() => second.close());
  assert.throws(
    () => second.open(dir),
    (e) => e.code === "ELOCKED",
  );
  assert(s.project);
});
