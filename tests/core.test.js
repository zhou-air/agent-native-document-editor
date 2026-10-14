import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { importDocx } from "../src/docx.js";
import { Store } from "../src/store.js";
import { plain, fromMarkdown, replaceText, assignIds } from "../src/content.js";
const fixture = fs.readFileSync(
  new URL("./fixtures/engineering.docx", import.meta.url),
);
const expected = JSON.parse(
  fs.readFileSync(new URL("./fixtures/expected.json", import.meta.url)),
);
const imported = await importDocx(fixture, "安全设施设计专篇.docx");
function store() {
  const s = new Store();
  s.create(
    fs.mkdtempSync(path.join(os.tmpdir(), "agentdoc-test-")),
    "test",
    imported,
  );
  return s;
}
function grid(table) {
  const matrix = [];
  for (let r = 0; r < table.content.length; r++) {
    matrix[r] ??= [];
    let c = 0;
    for (const cell of table.content[r].content) {
      while (matrix[r][c] !== undefined) c++;
      const text = cell.content.map(plain).filter(Boolean).join("\n");
      for (let y = 0; y < cell.attrs.rowspan; y++)
        for (let x = 0; x < cell.attrs.colspan; x++) {
          matrix[r + y] ??= [];
          matrix[r + y][c + x] = text;
        }
      c += cell.attrs.colspan;
    }
  }
  return matrix;
}
test("DOCX: headings, inherited heading style, numbered body not heading, automatic heading 7/8", () => {
  assert.deepEqual(
    imported.sections.map((s) => s.title),
    expected.titles,
  );
  assert.deepEqual(
    imported.sections.map((s) => s.level),
    expected.levels,
  );
  assert.equal(imported.sections[3].parentId, imported.sections[2].id);
});
test("DOCX: gridSpan + vMerge logical grid matches independent oracle; multi-paragraph merged cell", () => {
  const table = imported.sections[3].blocks.find((b) => b.type === "table");
  assert.deepEqual(grid(table.node), expected.matrix);
  assert.match(table.markdown, /<table>/);
  assert.match(table.markdown, /rowspan="2"/);
  assert.match(table.markdown, /colspan="2"/);
});
test("DOCX: inline emphasis, explicit bold false, separate duplicate paragraphs", () => {
  const blocks = imported.sections[1].blocks;
  assert.match(blocks[1].markdown, /\*\*设计压力为 1.6 MPa。\*\*/);
  assert.match(blocks[1].markdown, /_应设置独立泄压设施。_/);
  const runs = blocks[2].node.content;
  assert(runs[0].marks.some((m) => m.type === "bold"));
  assert(!runs[1].marks?.some((m) => m.type === "bold"));
  assert.equal(blocks[3].markdown, blocks[4].markdown);
  assert.notEqual(blocks[3].id, blocks[4].id);
});
test("DOCX: image same name/different bytes, repeated reference and table image", () => {
  assert.equal(Object.keys(imported.assets).length, 2);
  const blocks = imported.sections[3].blocks;
  const pics = blocks.filter((b) => b.type === "image");
  assert.equal(pics.length, 3);
  assert.equal(pics[0].node.attrs.src, pics[1].node.attrs.src);
  assert.notEqual(pics[1].node.attrs.src, pics[2].node.attrs.src);
  assert(
    !Object.values(imported.assets)[0].equals(
      Object.values(imported.assets)[1],
    ),
  );
  const table = blocks.filter((b) => b.type === "table")[1];
  assert.equal(table.node.content[0].content[0].content[0].type, "image");
});
test("DOCX: styles definitions, inheritance, overrides, captions and page settings", () => {
  assert.equal(imported.styles.semantic.headings[1].font.sizePt, 20);
  assert.equal(imported.styles.semantic.headings[3].font.bold, true);
  assert.equal(imported.styles.semantic.body.font.eastAsia, "宋体");
  assert(imported.styles.semantic.captions.Caption);
  assert.equal(imported.styles.pages[0].size.w, "11906");
  assert(Object.keys(imported.styles.localOverrides).length > 0);
});
test("Markdown roundtrip handles simple tables, list text, rich text and images", () => {
  const cases = [
    "hello **bold** _italic_",
    "- one\n- two",
    "| A | B |\n| --- | --- |\n| X | Y |",
    "![a](assets/a.png)",
  ];
  for (const md of cases) {
    const ns = fromMarkdown(md);
    assert(ns.length);
    if (md.startsWith("-")) assert.match(plain(ns[0]), /one/);
    if (md.startsWith("|")) assert.equal(ns[0].content.length, 2);
  }
});
test("Edit one block preserves all other blocks and IDs; restart and move preserve identity", () => {
  const s = store();
  try {
    const before = s.snapshot();
    const b = before.sections[1].blocks[1],
      id = b.id;
    s.apply("replace_text", {
      block_id: id,
      expected_revision: b.revision,
      old_text: "1.6 MPa",
      new_text: "1.8 MPa",
    });
    let after = s.snapshot();
    assert.equal(after.sections[1].blocks[1].id, id);
    assert.deepEqual(
      after.sections[1].blocks.filter((x) => x.id !== id),
      before.sections[1].blocks.filter((x) => x.id !== id),
    );
    const target = after.sections[2];
    s.apply("move_block", {
      block_id: id,
      expected_revision: 2,
      section_id: target.id,
      target_revision: target.revision,
    });
    const directory = s.dir;
    s.close();
    s.open(directory);
    const result = s.apply("read_block", { block_id: id });
    assert.match(result.markdown, /1.8 MPa/);
    assert.equal(result.sectionId, target.id);
    assert.equal(result.id, id);
    assert(fs.existsSync(path.join(directory, "styles.json")));
  } finally {
    s.close();
  }
});
test("Replace exact unique text across marks; zero/multiple matches reject without mutation", () => {
  const s = store();
  try {
    const b = s.project.sections[1].blocks[1],
      original = s.snapshot();
    assert.throws(() =>
      s.apply("replace_text", {
        block_id: b.id,
        expected_revision: 1,
        old_text: "不存在",
        new_text: "x",
      }),
    );
    assert.deepEqual(s.snapshot(), original);
    const n = assignIds({
      type: "paragraph",
      content: [
        { type: "text", text: "one " },
        { type: "text", text: "two", marks: [{ type: "bold" }] },
      ],
    });
    assert.equal(plain(replaceText(n, "one two", "new")), "new");
    assert.throws(() =>
      replaceText(
        { type: "paragraph", content: [{ type: "text", text: "same same" }] },
        "same",
        "new",
      ),
    );
  } finally {
    s.close();
  }
});
test("Atomic transaction rejects stale revision and prevents partial mutations", () => {
  const s = store();
  try {
    const b = s.project.sections[1].blocks[1];
    s.apply("replace_text", {
      block_id: b.id,
      expected_revision: 1,
      old_text: "1.6",
      new_text: "2.0",
    });
    const bytes = fs.readFileSync(path.join(s.dir, "project.json"), "utf8");
    assert.throws(
      () =>
        s.apply("replace_text", {
          block_id: b.id,
          expected_revision: 1,
          old_text: "2.0",
          new_text: "9.9",
        }),
      (e) => e.code === 409,
    );
    assert.equal(
      fs.readFileSync(path.join(s.dir, "project.json"), "utf8"),
      bytes,
    );
  } finally {
    s.close();
  }
});
test("UI dirty block + MCP different block merge; same-block collision retains persisted winner", () => {
  const s = store();
  try {
    const sec = structuredClone(s.project.sections[1]);
    const ns = sec.blocks.map((b) => structuredClone(b.node));
    ns[3].content[0].text += " 人类新增";
    const args = {
      section_id: sec.id,
      nodes: ns,
      changed: [ns[3]],
      versions: Object.fromEntries(sec.blocks.map((b) => [b.id, b.revision])),
      base_ids: sec.blocks.map((b) => b.id),
      section_revision: sec.revision,
    };
    s.apply("replace_text", {
      block_id: sec.blocks[1].id,
      expected_revision: 1,
      old_text: "1.6",
      new_text: "1.9",
    });
    s.apply("save_section", args);
    assert.match(s.project.sections[1].blocks[1].markdown, /1.9/);
    assert.match(s.project.sections[1].blocks[3].markdown, /人类新增/);
    assert.throws(
      () => s.apply("save_section", args),
      (e) => e.code === 409,
    );
  } finally {
    s.close();
  }
});
test("Second owner cannot open project and overwrite authoritative store", () => {
  const s = store(),
    second = new Store();
  try {
    assert.throws(
      () => second.open(s.dir),
      (e) => e.code === "ELOCKED",
    );
  } finally {
    s.close();
    second.close();
  }
});
test("Export portable package verifies all assets after moving to clean directory, plus selected section", async () => {
  const s = store();
  try {
    const zip = await JSZip.loadAsync(await s.export());
    for (const f of [
      "document.md",
      "structure.json",
      "styles.json",
      "export-rules.md",
      "word-prompt.txt",
      "original/source.docx",
    ])
      assert(zip.file(f));
    const clean = fs.mkdtempSync(path.join(os.tmpdir(), "agentdoc-export-"));
    for (const [name, file] of Object.entries(zip.files))
      if (!file.dir) {
        const dest = path.join(clean, name);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, await file.async("nodebuffer"));
      }
    const md = fs.readFileSync(path.join(clean, "document.md"), "utf8");
    for (const src of [...md.matchAll(/(?:\]\(|src=")(assets\/[\w.-]+)/g)].map(
      (m) => m[1],
    ))
      assert(fs.existsSync(path.join(clean, src)));
    const str = JSON.parse(fs.readFileSync(path.join(clean, "structure.json")));
    assert.deepEqual(
      grid(str.sections[3].blocks.find((b) => b.type === "table").node),
      expected.matrix,
    );
    const single = await JSZip.loadAsync(
      await s.export([s.project.sections[3].id]),
    );
    assert.equal(
      JSON.parse(await single.file("structure.json").async("string")).sections
        .length,
      1,
    );
  } finally {
    s.close();
  }
});

test("Unsupported Word fields are warned and original bytes are retained", async () => {
  const zip = await JSZip.loadAsync(fixture);
  let doc = await zip.file("word/document.xml").async("string");
  doc = doc.replace(
    "</w:body>",
    '<w:p><w:r><w:fldChar w:fldCharType="begin"/><w:instrText>DATE</w:instrText></w:r></w:p></w:body>',
  );
  zip.file("word/document.xml", doc);
  const bytes = await zip.generateAsync({ type: "nodebuffer" });
  const p = await importDocx(bytes);
  assert(p.warnings.some((w) => w.includes("fldChar")));
  assert(p.original.equals(bytes));
});
