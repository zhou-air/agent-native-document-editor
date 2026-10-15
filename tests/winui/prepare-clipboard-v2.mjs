import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../../src/store.js';

const [projectDirectory, seedPath] = process.argv.slice(2);
if (!projectDirectory || !seedPath) throw new Error('Usage: prepare-clipboard-v2.mjs project-directory seed-path');
const text = value => ({type: 'text', text: value});
const paragraph = value => ({type: 'paragraph', attrs: {id: randomUUID()}, content: [text(value)]});
const block = node => ({id: node.attrs.id, type: node.type, revision: 1, node});
const heading = value => ({type: 'heading', attrs: {id: randomUUID()}, content: [text(value)]});
const sourceHeading = heading('1 剪贴板来源');
const rich = {type: 'paragraph', attrs: {id: randomUUID()}, content: [
  text('H'), {type: 'text', text: '2', marks: [{type: 'subscript'}]}, text('O '),
  {type: 'text', text: 'bold', marks: [{type: 'bold'}]}, text(' + m'),
  {type: 'text', text: '2', marks: [{type: 'superscript'}]}, text(' '),
  {type: 'text', text: 'link', marks: [{type: 'link', attrs: {href: 'https://example.com/clipboard'}}]},
]};
const plain = paragraph('来源的第二个段落。');
const table = {type: 'table', attrs: {id: randomUUID()}, content: [
  {type: 'tableRow', attrs: {id: randomUUID()}, content: [
    {type: 'tableHeader', attrs: {id: randomUUID(), rowspan: 1, colspan: 2}, content: [paragraph('合并标题')]},
  ]},
  {type: 'tableRow', attrs: {id: randomUUID()}, content: ['A1', 'A2'].map(value => ({
    type: 'tableCell', attrs: {id: randomUUID(), rowspan: 1, colspan: 1}, content: [paragraph(value)],
  }))},
]};
const sourceTail = paragraph('来源的末尾段落。');
const targetHeading = heading('2 剪贴板目标');
const targetAnchor = paragraph('目标原文保持完整。');
const targetTail = paragraph('目标原有后续段落。');
const sourceId = randomUUID();
const targetId = randomUUID();
const largeTableSectionId = randomUUID();
const largeTableHeading = heading('3 大表格交互');
const largeTable = {type: 'table', attrs: {id: randomUUID()}, content: Array.from({length: 11}, (_, row) => ({
  type: 'tableRow', attrs: {id: randomUUID()}, content: Array.from({length: 10}, (_, col) => ({
    type: 'tableCell', attrs: {id: randomUUID(), rowspan: 1, colspan: 1}, content: [paragraph(`R${row + 1}C${col + 1}`)],
  })),
}))};
const store = new Store();
try {
  store.create(path.resolve(projectDirectory), '剪贴板隔离验收', {
    id: randomUUID(), title: '剪贴板隔离验收', revision: 1, warnings: [],
    sections: [
      {id: sourceId, title: '1 剪贴板来源', parentId: null, revision: 1, headingBlockId: sourceHeading.attrs.id, blocks: [sourceHeading, rich, plain, table, sourceTail].map(block)},
      {id: targetId, title: '2 剪贴板目标', parentId: null, revision: 1, headingBlockId: targetHeading.attrs.id, blocks: [targetHeading, targetAnchor, targetTail].map(block)},
      {id: largeTableSectionId, title: '3 大表格交互', parentId: null, revision: 1, headingBlockId: largeTableHeading.attrs.id, blocks: [largeTableHeading, largeTable].map(block)},
    ],
  });
  fs.mkdirSync(path.dirname(seedPath), {recursive: true});
  fs.writeFileSync(seedPath, JSON.stringify({
    sourceId, sourceTitle: '1 剪贴板来源', targetId, targetTitle: '2 剪贴板目标',
    richId: rich.attrs.id, plainId: plain.attrs.id, tableId: table.attrs.id,
    sourceTailId: sourceTail.attrs.id, targetAnchorId: targetAnchor.attrs.id, targetTailId: targetTail.attrs.id,
    richPlain: 'H2O bold + m2 link',
    largeTableSectionId, largeTableId: largeTable.attrs.id,
  }, null, 2));
} finally { store.close(); }
