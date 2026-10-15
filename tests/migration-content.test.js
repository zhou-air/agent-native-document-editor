import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDatabase, DEFAULT_STYLES, exportStyles } from '../src/migration.js';
import { SqliteRepository } from '../src/repository.js';
import { Store } from '../src/store.js';
import { uid } from '../src/content.js';

const opened = new Map();
function scope(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdoc-migration-content-'));
  fs.mkdirSync(path.join(directory, 'assets'));
  opened.set(directory, []);
  t.after(() => { for (const repository of opened.get(directory)) repository.close(); opened.delete(directory); fs.rmSync(directory, { recursive: true, force: true }); });
  return directory;
}
const paragraph = (text, extras = {}) => ({ id: uid(), type: 'paragraph', revision: 3, node: { type: 'paragraph', attrs: { fontFamily: '宋体', fontSize: 12 }, content: [{ type: 'text', text }], ...extras } });
function section(title, parentId = null) {
  const h = { id: uid(), type: 'heading', node: { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: title }] } };
  return { id: uid(), parentId, title, headingBlockId: h.id, blocks: [h], revision: 2 };
}
function project(sections) { return { id: uid(), formatVersion: 1, revision: 4, sections, styles: { semantic: { body: { font: { eastAsia: '宋体', sizePt: 12 } }, headings: {} }, pages: [{ size: { w: '11906', h: '16838' }, margins: { top: '1440' }, xml: '<w:sectPr>legacy raw xml</w:sectPr>' }], definitions: { Normal: { xml: '<w:style/>' } }, localOverrides: {} } }; }
function open(t, directory, p) {
  const file = path.join(directory, 'document.sqlite'); const report = createDatabase(file, p, directory), repository = new SqliteRepository(file);
  opened.get(directory).push(repository); return { repository, report };
}
test('migration preserves every source block, text and semantic marks; Word XML stays outside the database', t => {
  const directory = scope(t), a = section('A'), b = section('A.1', a.id);
  const body = paragraph('压力 1.6 MPa。', { content: [{ type: 'text', text: '压力 1.6 MPa。', marks: [{ type: 'bold' }] }, { type: 'hardBreak', attrs: { id: uid() } }, { type: 'text', text: '3', marks: [{ type: 'superscript' }] }] });
  a.blocks.push(body); b.blocks.push(paragraph('末段正文不可丢失。'));
  const p = project([a, b]), { repository, report } = open(t, directory, p);
  assert.equal(report.preservedBlockIds, 4);
  for (const s of p.sections) for (const original of s.blocks) {
    const read = repository.block(original.id); assert(read); assert.equal(read.section_id, s.id); assert.equal(read.revision, original.revision || 1);
    const content = JSON.parse(read.content); assert.deepEqual(content.content, original.node.content); assert.equal(content.attrs?.fontFamily, undefined);
  }
  assert(!repository.document().styles.includes('legacy raw xml'));
  assert(!repository.document().styles.includes('<w:'));
});
test('migration preserves authoritative mixed Block/Section order including parent tail content', t => {
  const directory = scope(t), a = section('A'), b = section('A.1', a.id), lead = paragraph('前部'), tail = paragraph('尾部');
  a.blocks.push(lead, tail); a.entries = [{ kind: 'block', id: a.headingBlockId }, { kind: 'block', id: lead.id }, { kind: 'section', id: b.id }, { kind: 'block', id: tail.id }];
  b.entries = [{ kind: 'block', id: b.headingBlockId }];
  const p = { ...project([a, b]), formatVersion: 2, rootEntries: [{ kind: 'section', id: a.id }] }, { repository } = open(t, directory, p);
  assert.deepEqual(repository.entries(a.id).map(({ kind, id }) => ({ kind, id })), a.entries);
});
test('migration preserves merged table cell content, inline image reference and bytes', t => {
  const directory = scope(t), s = section('表格'), imagePath = 'assets/picture.png', bytes = fs.readFileSync(new URL('./fixtures/a/diagram.png', import.meta.url));
  fs.writeFileSync(path.join(directory, imagePath), bytes);
  const p = text => ({ type: 'paragraph', content: [{ type: 'text', text }] });
  const table = { id: uid(), type: 'table', node: { type: 'table', content: [
    { type: 'tableRow', content: [{ type: 'tableCell', attrs: { rowspan: 2, colspan: 2 }, content: [p('合并单元格'), p('第二自然段'), { type: 'image', attrs: { src: imagePath, alt: '图示' } }] }, { type: 'tableCell', content: [p('A')] }] },
    { type: 'tableRow', content: [{ type: 'tableCell', content: [p('B')] }] },
  ] } }; s.blocks.push(table);
  const { repository } = open(t, directory, project([s])), read = JSON.parse(repository.block(table.id).content), merged = read.content[0].content[0];
  assert.equal(merged.attrs.rowspan, 2); assert.equal(merged.attrs.colspan, 2); assert.equal(merged.content[0].content[0].text, '合并单元格'); assert.equal(merged.content[1].content[0].text, '第二自然段');
  assert.equal(merged.content[2].attrs.src, imagePath); assert(fs.readFileSync(path.join(directory, imagePath)).equals(bytes));
});
test('migration rejects invalid source hierarchy rather than activating a reordered legacy document', t => {
  const directory = scope(t), a = section('A'), b = section('B'), child = section('A.1', a.id);
  assert.throws(() => createDatabase(path.join(directory, 'invalid.sqlite'), project([a, b, child]), directory), /顺序|层级|迁移/);
});
test('missing assets and invalid table geometry prevent activation', t => {
  const directory = scope(t), s = section('资产');
  s.blocks.push({ id: uid(), type: 'image', node: { type: 'image', attrs: { src: 'assets/missing.png' } } });
  assert.throws(() => createDatabase(path.join(directory, 'missing.sqlite'), project([s]), directory), /图片资源缺失/);
  s.blocks[1] = { id: uid(), type: 'table', node: { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', attrs: { rowspan: 2, colspan: 1 }, content: [{ type: 'paragraph', content: [] }] }] }] } };
  assert.throws(() => createDatabase(path.join(directory, 'invalid-table.sqlite'), project([s]), directory), /合并超出范围/);
});
test('template migration retains only supported output rules and consistent line units', () => {
  const result = exportStyles({ semantic: { body: { font: { eastAsia: '仿宋', sizePt: 14, xml: '<w:rPr/>' }, paragraph: { line: 360 }, xml: '<w:pPr/>' }, headings: { 1: { font: { bold: true }, styleId: 'sourceHeading', xml: '<w:style/>' } }, tables: { importedSource: { properties: { xml: '<w:tblPr/>' } } } }, pages: [{ size: { w: 11906, h: 16838 }, xml: '<w:sectPr/>' }] });
  assert.equal(DEFAULT_STYLES.semantic.body.paragraph.line, 360);
  assert.equal(result.semantic.body.font.eastAsia, '仿宋'); assert.equal(result.semantic.body.font.sizePt, 14);
  assert(!JSON.stringify(result).includes('<w:')); assert(!JSON.stringify(result).includes('sourceHeading'));
});
test('project creation saves import identity remapping and warning records', t => {
  const directory = scope(t), store = new Store(); opened.get(directory).push(store);
  const imported = { ...project([section('导入报告')]), formatVersion: 2, assets: {}, idMappings: [{ kind: 'node', oldId: 'invalid-id', newId: uid() }], warnings: ['测试导入警告'] };
  store.create(directory, '导入报告', imported);
  const report = JSON.parse(fs.readFileSync(path.join(directory, 'import-report.json'), 'utf8'));
  assert.deepEqual(report.idMappings, imported.idMappings); assert.deepEqual(report.warnings, imported.warnings); assert.equal(report.verified, true);
});
