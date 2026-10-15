import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { plain } from "../src/content.js";

function setup(t) {
  const store = new Store();
  store.create(
    fs.mkdtempSync(path.join(os.tmpdir(), "agentdoc-independent-review-")),
    "审查边界",
  );
  t.after(() => store.close());
  return { store, section: store.readSection(store.manifest().sections[0].id) };
}

test("a stale root-subtree deletion cannot be undone after restore, edit and deletion again", (t) => {
  const { store, section } = setup(t);
  const block = section.blocks[1];
  const firstDeletion = store.apply("delete_section", {
    section_id: section.id,
    expected_revision: section.revision,
  });
  store.apply("undo_change", {
    change_id: firstDeletion.changeId,
    expected_revision: store.project.revision,
  });
  const restored = store.apply("read_block", { block_id: block.id });
  store.apply("update_block", {
    block_id: block.id,
    expected_revision: restored.revision,
    markdown: "恢复后新的正文，不允许旧撤销覆盖",
  });
  const secondDeletion = store.apply("delete_section", {
    section_id: section.id,
    expected_revision: store.sectionRow(section.id).revision,
  });
  const revision = store.project.revision;
  assert.throws(
    () =>
      store.apply("undo_change", {
        change_id: firstDeletion.changeId,
        expected_revision: revision,
      }),
    (error) => error.code === 409,
  );
  assert.equal(store.project.revision, revision);
  assert.equal(store.repo.section(section.id), undefined);
  store.apply("undo_change", {
    change_id: secondDeletion.changeId,
    expected_revision: store.project.revision,
  });
  assert.equal(
    plain(store.apply("read_block", { block_id: block.id }).node),
    "恢复后新的正文，不允许旧撤销覆盖",
  );
});

test("deleting a paragraph via structural save preserves surviving content around child sections", (t) => {
  const { store, section } = setup(t);
  const child = store.apply("create_section", {
    title: "中间子章节",
    parent_id: section.id,
    expected_revision: store.project.revision,
  }).section;
  const tail = store.apply("create_block", {
    section_id: section.id,
    expected_revision: store.sectionRow(section.id).revision,
    markdown: "子章节之后的正文",
  }).block;
  const before = store.readSection(section.id);
  assert.deepEqual(
    before.entries.map((entry) => entry.id),
    [section.headingBlockId, section.blocks[1].id, child.id, tail.id],
  );
  store.apply("save_blocks", {
    section_id: section.id,
    section_revision: before.revision,
    base_ids: before.blockIds,
    order: [section.headingBlockId, tail.id],
    changed: [],
    created: [],
    deleted: [
      {
        block_id: section.blocks[1].id,
        expected_revision: section.blocks[1].revision,
      },
    ],
  });
  assert.deepEqual(
    store.readSection(section.id).entries.map((entry) => entry.id),
    [section.headingBlockId, child.id, tail.id],
  );
});

test("malformed list content is rejected before replacing valid persisted text", (t) => {
  const { store, section } = setup(t);
  const block = section.blocks[1],
    revision = store.project.revision;
  assert.throws(() =>
    store.apply("update_block", {
      block_id: block.id,
      expected_revision: block.revision,
      node: {
        type: "bulletList",
        content: [{ type: "text", text: "不能在导出时静默丢弃的正文" }],
      },
    }),
  );
  assert.equal(store.project.revision, revision);
  assert.equal(
    plain(store.apply("read_block", { block_id: block.id }).node),
    plain(block.node),
  );
});

test("structural fields without a target order fail instead of silently ignoring edits", (t) => {
  const { store, section } = setup(t),
    revision = store.project.revision;
  assert.throws(() =>
    store.apply("save_blocks", {
      section_id: section.id,
      section_revision: section.revision,
      base_ids: section.blockIds,
      changed: [],
      created: [
        {
          temporary_id: "new-draft-block",
          node: {
            type: "paragraph",
            content: [{ type: "text", text: "不应被忽略的新正文" }],
          },
        },
      ],
    }),
  );
  assert.equal(store.project.revision, revision);
  assert.deepEqual(store.readSection(section.id).blockIds, section.blockIds);
});

test("a stale tombstone restoration rolls back earlier content edits in the same batch", (t) => {
  const { store, section } = setup(t),
    original = section.blocks[1];
  const companion = store.apply("create_block", {
    section_id: section.id,
    expected_revision: section.revision,
    markdown: "必须保持原内容",
  }).block;
  const deleted = store.apply("delete_block", {
    block_id: original.id,
    expected_revision: original.revision,
  });
  const firstDeletedRevision = deleted.deletedBlockRevisions[original.id];
  let current = store.readSection(section.id);
  store.apply("save_blocks", {
    section_id: section.id,
    section_revision: current.revision,
    base_ids: current.blockIds,
    order: [...current.blockIds, original.id],
    changed: [],
    deleted: [],
    created: [
      {
        temporary_id: original.id,
        restore_id: original.id,
        expected_deleted_revision: firstDeletedRevision,
        node: original.node,
      },
    ],
  });
  const restored = store.apply("read_block", { block_id: original.id });
  store.apply("delete_block", {
    block_id: original.id,
    expected_revision: restored.revision,
  });
  current = store.readSection(section.id);
  const revision = store.project.revision;
  assert.throws(
    () =>
      store.apply("save_blocks", {
        section_id: section.id,
        section_revision: current.revision,
        base_ids: current.blockIds,
        order: [...current.blockIds, original.id],
        deleted: [],
        changed: [
          {
            block_id: companion.id,
            expected_revision: store.blockRow(companion.id).revision,
            markdown: "不能部分提交",
          },
        ],
        created: [
          {
            temporary_id: original.id,
            restore_id: original.id,
            expected_deleted_revision: firstDeletedRevision,
            node: original.node,
          },
        ],
      }),
    (error) => error.code === 409,
  );
  assert.equal(store.project.revision, revision);
  assert.equal(store.repo.block(original.id), undefined);
  assert.equal(
    plain(store.apply("read_block", { block_id: companion.id }).node),
    "必须保持原内容",
  );
});

test("scoped historical changes retain their original content and movement after destination deletion", (t) => {
  const { store, section } = setup(t),
    original = section.blocks[1];
  const destination = store.apply("create_section", {
    title: "临时目标",
    expected_revision: store.project.revision,
  }).section;
  const revision = store.project.revision;
  const edit = store.apply("update_block", {
    block_id: original.id,
    expected_revision: original.revision,
    markdown: "历史原章节内容",
  });
  store.apply("move_block", {
    block_id: original.id,
    expected_revision: edit.changedBlocks[0].revision,
    section_id: destination.id,
    target_revision: destination.revision,
  });
  store.apply("delete_section", {
    section_id: destination.id,
    expected_revision: store.sectionRow(destination.id).revision,
  });
  const page = store.apply("get_changes", {
    since_revision: revision,
    section_id: section.id,
  });
  assert.equal(page.changes.length, 3);
  assert.equal(page.changes[0].changedBlocks[0].sectionId, section.id);
  assert.equal(plain(page.changes[0].changedBlocks[0].node), "历史原章节内容");
  assert.deepEqual(page.changes[1].changedBlocks, []);
  assert.deepEqual(page.changes[1].removedFromSectionBlockIds, [original.id]);
  assert(page.changes[2].deletedBlockIds.includes(original.id));
  assert.equal(store.repo.block(original.id), undefined);
});
