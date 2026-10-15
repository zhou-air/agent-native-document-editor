import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const [backendRoot, fixturePath, projectPath, outputPath] = process.argv.slice(2);
const { importDocx } = await import(pathToFileURL(path.join(backendRoot, 'src/docx.js')));
const { Store } = await import(pathToFileURL(path.join(backendRoot, 'src/store.js')));
const imported = await importDocx(fs.readFileSync(fixturePath), 'engineering.docx');
assert.equal(imported.sections.length, 6);
const store = new Store();
try {
  store.create(projectPath, 'WinUI native acceptance', imported);
  const snapshot = store.snapshot();
  const paragraphSection = snapshot.sections[1];
  const paragraph = paragraphSection.blocks.find((block) => block.type === 'paragraph' && block.markdown.includes('1.6 MPa'));
  assert(paragraph, 'The independent DOCX fixture must contain the pressure paragraph.');
  const richSection = snapshot.sections[3];
  assert(richSection.blocks.some((block) => block.type === 'table'));
  assert(richSection.blocks.some((block) => block.type === 'image'));
  fs.writeFileSync(outputPath, JSON.stringify({
    projectId: snapshot.id,
    titles: snapshot.sections.map((section) => section.title),
    levels: snapshot.sections.map((section) => section.level),
    paragraphSectionId: paragraphSection.id,
    paragraphId: paragraph.id,
    richSectionId: richSection.id,
    originalParagraph: paragraph,
    originalParagraphSection: paragraphSection,
    originalStyles: snapshot.styles,
  }, null, 2));
} finally {
  store.close();
}
