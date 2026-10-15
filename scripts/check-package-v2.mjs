import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('../', import.meta.url));
const release = path.join(root, 'release/AgentDocument-WinUI-x64');
const backend = path.join(release, 'backend');
const payload = JSON.parse(fs.readFileSync(path.join(backend, 'package.json'), 'utf8').replace(/^\uFEFF/, ''));
if (payload.version !== '0.2.0' || Object.keys(payload.dependencies).some(k => /electron|tiptap/.test(k))) throw Error('不是清理后的 v2 发布后端');
for (const f of ['AgentDocument.WinUI.exe','Microsoft.UI.Xaml.dll','coreclr.dll','hostfxr.dll','backend/node.exe','backend/src/repository.js']) {
  if (!fs.existsSync(path.join(release,f))) throw Error('缺少便携运行组件：' + f);
}
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdoc-packaged-v2-'));
const source = `
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {Store} from ${JSON.stringify(pathToFileURL(path.join(backend,'src/store.js')).href)};
import {importDocx} from ${JSON.stringify(pathToFileURL(path.join(backend,'src/docx.js')).href)};
const fixture=fs.readFileSync(process.argv[2]);
const s=new Store();const p=s.create(process.argv[1],'打包验证',await importDocx(fixture));
const blocks=p.sections.flatMap(x=>s.readSection(x.id).blocks), b=blocks.find(x=>x.type==='paragraph');
const edit=s.apply('update_block',{block_id:b.id,expected_revision:b.revision,markdown:'发布包实际保存验证'});
assert.equal(edit.changedBlocks[0].id,b.id); const r=s.project.revision;s.close();s.open(process.argv[1]);
assert.equal(s.project.revision,r);assert.equal(s.apply('read_block',{block_id:b.id}).markdown,'发布包实际保存验证');
const out=await s.exportDocx();fs.writeFileSync(process.argv[1]+'/package-export.docx',out);
const read=await importDocx(out);assert(read.sections.flatMap(s=>s.blocks).some(x=>x.id===b.id));
s.close();console.log(JSON.stringify({version:'0.2.0',node:process.version,sections:p.sections.length,blocks:blocks.length,exportBytes:out.length,stableEditedId:b.id,createSaveReopenExportImport:true}));
`;
const result = spawnSync(path.join(backend,'node.exe'), ['--input-type=module','-e',source,directory,path.join(root,'tests/fixtures/engineering.docx')], {
  cwd: backend, encoding:'utf8', windowsHide:true,
  env: { ...process.env, NODE_PATH: '', PATH: path.dirname(process.execPath) },
});
if (result.status !== 0) throw Error(result.stderr || result.stdout || result.error?.message);
const evidence = { timestamp:new Date().toISOString(),release,backendNode:path.join(backend,'node.exe'),directory, ...JSON.parse(result.stdout.trim()) };
fs.writeFileSync(path.join(root,'artifacts/refactor-20261014/package-check.json'),JSON.stringify(evidence,null,2));
console.log(JSON.stringify(evidence,null,2));
