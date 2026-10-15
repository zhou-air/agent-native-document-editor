import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import JSZip from "jszip";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { importDocx } from "../src/docx.js";
import { exportDocx, DEFAULT_EXPORT_TEMPLATE } from "../src/docx-export.js";
import { assignIds, block, plain } from "../src/content.js";

const fixture = fs.readFileSync(new URL("./fixtures/engineering.docx", import.meta.url));
const expected = JSON.parse(fs.readFileSync(new URL("./fixtures/expected.json", import.meta.url)));
const source = await importDocx(fixture, "语义文档.docx");
const allBlocks = p => p.sections.flatMap(s => s.blocks);
const allText = p => allBlocks(p).map(b => plain(b.node)).join("\n");
const paragraph = text => block(assignIds({ type: "paragraph", content: [{ type: "text", text }] }));
function grid(node) {
  const result = [];
  for (const [r, row] of node.content.entries()) {
    result[r] ||= []; let c = 0;
    for (const cell of row.content) {
      while (result[r][c] !== undefined) c++;
      const value = cell.content.map(plain).filter(Boolean).join("\n");
      for (let y = 0; y < cell.attrs.rowspan; y++) for (let x = 0; x < cell.attrs.colspan; x++) { result[r + y] ||= []; result[r + y][c + x] = value; }
      c += cell.attrs.colspan;
    }
  }
  return result;
}
async function mutate(buffer, change) {
  const zip = await JSZip.loadAsync(buffer);
  zip.file("word/document.xml", change(await zip.file("word/document.xml").async("string")));
  return zip.generateAsync({ type: "nodebuffer" });
}
async function mutateControls(buffer, change) {
  return mutate(buffer, text => {
    const document = new DOMParser().parseFromString(text, 'text/xml'), body = document.getElementsByTagName('w:body')[0];
    const controls = [...body.childNodes].filter(n => n.nodeName === 'w:sdt');
    const find = id => controls.find(n => n.getElementsByTagName('w:tag')[0].getAttribute('w:val') === 'agent-document:block:' + id);
    change({ document, body, controls, find }); return new XMLSerializer().serializeToString(document);
  });
}
function orderedIds(p) {
  const sections = new Map(p.sections.map(s => [s.id, s])), result = [];
  function visit(entries) { for (const e of entries) { if (e.kind === 'block') result.push(e.id); else visit(sections.get(e.id).entries); } }
  visit(p.rootEntries); return result;
}
test("semantic import preserves headings, inherited emphasis, numbering, merged cells and assets without Word mirrors", () => {
  assert.deepEqual(source.sections.map(s => s.title), expected.titles);
  assert.deepEqual(source.sections.map(s => s.level), expected.levels);
  assert.deepEqual(grid(allBlocks(source).find(b => b.type === "table").node), expected.matrix);
  assert.equal(Object.keys(source.assets).length, 2);
  assert(allBlocks(source).every(b => !b.source));
  assert.equal(source.styles.definitions, undefined);
  assert.equal(source.styles.localOverrides, undefined);
  assert.equal(source.styles.pages[0].xml, undefined);
  const inherited = allBlocks(source).find(b => plain(b.node).startsWith("继承加粗"));
  assert(inherited.node.content[0].marks.some(m => m.type === "bold"));
  assert(!inherited.node.content[1].marks?.some(m => m.type === "bold"));
});
test("DOCX round trip preserves document/section/block identities, all text, merged grid and actual image bytes", async () => {
  const output = await exportDocx(source), restored = await importDocx(output);
  assert.equal(restored.id, source.id);
  assert.deepEqual(restored.sections.map(s => s.id), source.sections.map(s => s.id));
  assert.deepEqual(allBlocks(restored).map(b => b.id), allBlocks(source).map(b => b.id));
  assert.equal(allText(restored), allText(source));
  assert.deepEqual(restored.sections.map(s => s.entries), source.sections.map(s => s.entries));
  assert.deepEqual(restored.rootEntries, source.rootEntries);
  assert.deepEqual(grid(allBlocks(restored).find(b => b.type === "table").node), expected.matrix);
  assert.deepEqual(restored.assets, source.assets);
  const zip = await JSZip.loadAsync(output);
  assert(zip.file("word/document.xml")); assert(zip.file("customXml/item1.xml")); assert(zip.file("word/styles.xml"));
  const doc = new DOMParser().parseFromString(await zip.file("word/document.xml").async("string"), "text/xml");
  assert.equal([...doc.getElementsByTagName("w:body")[0].childNodes].filter(n => n.nodeName === "w:sdt").length, allBlocks(source).length);
  assert.equal(restored.warnings.length, 0);
});
test("interleaved parent content after a child section follows entries and restores exact ownership", async () => {
  const p = structuredClone(source), parent = p.sections[1], nested = p.sections[2], trailing = paragraph("父章节在子章节之后的结语");
  trailing.sectionId = parent.id; trailing.revision = 1;
  parent.blocks.push(trailing); parent.entries.push({ kind: "block", id: trailing.id });
  const restored = await importDocx(await exportDocx(p));
  assert.equal(restored.sections.find(s => s.id === parent.id).blocks.at(-1).id, trailing.id);
  assert.deepEqual(restored.sections.find(s => s.id === parent.id).entries, parent.entries);
  assert.equal(restored.sections.find(s => s.id === nested.id).parentId, parent.id);
});
test("subscript, superscript, line break and hyperlinks survive content-only export", async () => {
  const p = structuredClone(source), b = p.sections[1].blocks[1];
  b.node.content = [
    { type: "text", text: "H" }, { type: "text", text: "2", marks: [{ type: "subscript" }] },
    { type: "text", text: "O / m" }, { type: "text", text: "3", marks: [{ type: "superscript" }] },
    { type: "hardBreak" }, { type: "text", text: "来源", marks: [{ type: "link", attrs: { href: "https://example.org/?a=1&b=2" } }, { type: "bold" }] },
  ]; assignIds(b.node);
  const restored = await importDocx(await exportDocx(p)), node = allBlocks(restored).find(x => x.id === b.id).node;
  const marksAsSet = content => content.map(n => ({ ...n, ...(n.marks ? { marks: [...n.marks].sort((a, b) => a.type.localeCompare(b.type)) } : {}) }));
  assert.deepEqual(marksAsSet(node.content), marksAsSet(b.node.content));
});
test("copied or invalid Word identity tags are remapped without dropping copied text", async () => {
  const output = await exportDocx(source), chosen = source.sections[1].blocks[1];
  const changed = await mutate(output, xml => {
    const control = xml.match(new RegExp(`<w:sdt><w:sdtPr>[^]*?agent-document:block:${chosen.id}[^]*?<\\/w:sdt>`));
    // Select by DOM-shaped boundary rather than accidentally copying preceding controls.
    const exact = xml.split("<w:sdt>").find(x => x.split("</w:sdt>")[0].includes(`agent-document:block:${chosen.id}`)).split("</w:sdt>")[0];
    assert(control);
    return xml.replace("<w:sectPr>", `<w:sdt>${exact}</w:sdt><w:sectPr>`);
  });
  const restored = await importDocx(changed), ids = allBlocks(restored).map(b => b.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(allBlocks(restored).filter(b => plain(b.node) === plain(chosen.node)).length, 2);
  assert(restored.idMappings.some(m => m.oldId === chosen.id));
  assert(restored.warnings.some(w => w.includes("重复或无效")));
  const invalid = await importDocx(await mutate(output, xml => xml.replace(`agent-document:block:${chosen.id}`, "agent-document:block:invalid-id")));
  assert(invalid.idMappings.some(m => m.oldId === "invalid-id"));
});
test("content controls and unsupported math are extracted with explicit warnings", async () => {
  const changed = await mutate(fixture, xml => xml.replace("</w:body>", '<w:sdt><w:sdtContent><w:p><w:r><w:t>控件里的重要正文</w:t></w:r></w:p></w:sdtContent></w:sdt><w:p><m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><m:r><m:t>x+y</m:t></m:r></m:oMath></w:p><w:altChunk r:id="missing"/></w:body>'));
  const result = await importDocx(changed);
  assert(allText(result).includes("控件里的重要正文")); assert(allText(result).includes("x+y"));
  assert(result.warnings.some(w => w.includes("公式"))); assert(result.warnings.some(w => w.includes("altChunk")));
  assert(result.original.equals(changed));
});
test("vertical continuation cell text is retained and reported", async () => {
  const changed = await mutate(fixture, xml => xml.replace(/(<w:tcPr>[^]*?<w:vMerge\s*\/>[^]*?<\/w:tcPr>)\s*<w:p\s*\/>/, '$1<w:p><w:r><w:t>续接格不能丢失</w:t></w:r></w:p>'));
  const result = await importDocx(changed);
  assert(allText(result).includes("续接格不能丢失"));
  assert(result.warnings.some(w => w.includes("续接单元格含正文")));
});
test("missing images, unknown content and omitted placements fail export rather than silently disappear", async () => {
  await assert.rejects(exportDocx(source, { assetReader: () => null }), /图片资源不存在/);
  const unknown = structuredClone(source); unknown.sections[0].blocks[0].node.type = "futureEquation";
  await assert.rejects(exportDocx(unknown), /未支持的块类型/);
  const omitted = structuredClone(source); omitted.sections[0].entries = [];
  await assert.rejects(exportDocx(omitted), /未归属/);
});
test("export template controls Word styles without adding formatting to content", async () => {
  const template = structuredClone(DEFAULT_EXPORT_TEMPLATE); template.semantic.body.font.eastAsia = "仿宋"; template.semantic.body.font.sizePt = 15;
  const before = JSON.stringify(source.sections), zip = await JSZip.loadAsync(await exportDocx(source, { template }));
  assert((await zip.file("word/styles.xml").async("string")).includes('w:eastAsia="仿宋"'));
  assert((await zip.file("word/styles.xml").async("string")).includes('w:sz w:val="30"'));
  assert.equal(JSON.stringify(source.sections), before);
});

test("body bold does not leak into independent heading and table styles", async () => {
  const template = structuredClone(DEFAULT_EXPORT_TEMPLATE); template.semantic.body.font.bold = true; template.semantic.headings[1].font.bold = false;
  const zip = await JSZip.loadAsync(await exportDocx(source, { template }));
  const doc = new DOMParser().parseFromString(await zip.file('word/styles.xml').async('string'), 'application/xml');
  const styles = [...doc.getElementsByTagName('w:style')];
  for (const id of ['Heading1','TableText']) {
    const style = styles.find(s => s.getAttribute('w:styleId') === id);
    assert.equal(style.getElementsByTagName('w:b')[0].getAttribute('w:val'), '0');
  }
});
test('Word moves across sections take actual DOCX order over stale metadata without changing block identity', async () => {
  const moved = source.sections[1].blocks[1], target = source.sections[4], bytes = await exportDocx(source);
  const modified = await mutateControls(bytes, ({ body, find }) => body.insertBefore(find(moved.id), find(target.headingBlockId).nextSibling));
  const restored = await importDocx(modified), block = allBlocks(restored).find(b => b.id === moved.id);
  assert.equal(block.sectionId, target.id); assert.equal(plain(block.node), plain(moved.node));
  const expected = orderedIds(source).filter(id => id !== moved.id); expected.splice(expected.indexOf(target.headingBlockId) + 1, 0, moved.id);
  assert.deepEqual(orderedIds(restored), expected);
  assert.deepEqual(orderedIds(await importDocx(await exportDocx(restored))), expected);
  assert(restored.warnings.some(w => w.includes('实际正文顺序')));
});
test('Word heading demotion or deletion does not resurrect the section from metadata', async () => {
  const original = source.sections[2], bytes = await exportDocx(source);
  const demoted = await importDocx(await mutateControls(bytes, ({ find }) => find(original.headingBlockId).getElementsByTagName('w:pStyle')[0].setAttribute('w:val', 'Normal')));
  assert(!demoted.sections.some(s => s.id === original.id));
  assert.equal(allBlocks(demoted).find(b => b.id === original.headingBlockId).type, 'paragraph');
  assert.deepEqual(orderedIds(demoted), orderedIds(source));
  const removed = await importDocx(await mutateControls(bytes, ({ body, find }) => body.removeChild(find(original.headingBlockId))));
  assert(!removed.sections.some(s => s.id === original.id));
  assert.deepEqual(orderedIds(removed), orderedIds(source).filter(id => id !== original.headingBlockId));
  for (const b of original.blocks.slice(1)) assert(allBlocks(removed).some(x => x.id === b.id && plain(x.node) === plain(b.node)));
});
test('Word heading reordering and added headings rebuild hierarchy in actual order while reusing surviving identities', async () => {
  const last = source.sections.at(-1), before = source.sections.at(-2), bytes = await exportDocx(source);
  const modified = await mutateControls(bytes, ({ document, body, find }) => {
    for (const b of last.blocks) body.insertBefore(find(b.id), find(before.headingBlockId));
    const heading = document.createElement('w:p'); heading.appendChild(new DOMParser().parseFromString('<w:pPr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:pStyle w:val="Heading1"/></w:pPr>', 'text/xml').documentElement);
    const run = document.createElement('w:r'), text = document.createElement('w:t'); text.appendChild(document.createTextNode('Word 新增章节')); run.appendChild(text); heading.appendChild(run);
    body.insertBefore(heading, find(before.headingBlockId));
  });
  const restored = await importDocx(modified), sections = restored.sections;
  assert(sections.findIndex(s => s.id === last.id) < sections.findIndex(s => s.id === before.id));
  const added = sections.find(s => s.title === 'Word 新增章节'); assert(added); assert(added.headingBlockId);
  assert.equal(new Set(allBlocks(restored).map(b => b.id)).size, allBlocks(restored).length);
  for (const b of allBlocks(source)) assert(allBlocks(restored).some(x => x.id === b.id && plain(x.node) === plain(b.node)));
  assert.deepEqual(orderedIds(await importDocx(await exportDocx(restored))), orderedIds(restored));
});
test('parallel image references inside one table cell reuse the same resource', async () => {
  const p = structuredClone(source), table = allBlocks(p).filter(b => b.type === 'table')[1], cell = table.node.content[0].content[0];
  const image = cell.content.find(n => n.type === 'image'); cell.content = [assignIds(structuredClone(image), true), assignIds(structuredClone(image), true)];
  const result = await importDocx(await exportDocx(p, { assetReader: async src => p.assets[src] }));
  assert.equal(Object.keys(result.assets).length, 2);
  const images = allBlocks(result).find(b => b.id === table.id).node.content[0].content[0].content.filter(n => n.type === 'image');
  assert.equal(images.length, 2); assert.equal(images[0].attrs.src, images[1].attrs.src);
});
