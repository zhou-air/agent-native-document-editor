import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const [backendRoot, archivePath, outputPath] = process.argv.slice(2);
const { default: JSZip } = await import(pathToFileURL(path.join(backendRoot, 'node_modules/jszip/lib/index.js')));
const archive = await JSZip.loadAsync(fs.readFileSync(archivePath));
for (const name of ['document.md', 'structure.json', 'styles.json', 'export-rules.md', 'word-prompt.txt', 'original/source.docx']) {
  assert(archive.file(name), `Required export entry is missing: ${name}`);
}
const structure = JSON.parse(await archive.file('structure.json').async('string'));
const markdown = await archive.file('document.md').async('string');
const imagePaths = new Set();
function visit(node) {
  if (node.type === 'image' && node.attrs?.src?.startsWith('assets/')) imagePaths.add(node.attrs.src);
  for (const child of node.content ?? []) visit(child);
}
for (const section of structure.sections) for (const block of section.blocks) visit(block.node);
for (const imagePath of imagePaths) assert(archive.file(imagePath), `Referenced image is missing: ${imagePath}`);
assert(markdown.includes('1.8 MPa'), 'MCP-edited paragraph is missing from export.');
fs.writeFileSync(outputPath, JSON.stringify({
  archivePath,
  sectionCount: structure.sections.length,
  referencedImageCount: imagePaths.size,
  archiveEntryCount: Object.keys(archive.files).length,
  bytes: fs.statSync(archivePath).size,
}, null, 2));
