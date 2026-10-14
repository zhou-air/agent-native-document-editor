import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { Store } from "../src/store.js";
import { uid, assignIds, block } from "../src/content.js";
const s = new Store(),
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentdoc-large-"));
s.create(dir, "large");
const sections = Array.from({ length: 100 }, (_, i) => ({
  id: uid(),
  title: `${i + 1} 工程章节`,
  level: 1,
  parentId: null,
  blocks: Array.from({ length: 50 }, (_, j) =>
    block(
      assignIds({
        type: "paragraph",
        content: [
          {
            type: "text",
            text: `章节 ${i + 1} 段落 ${j + 1}：设计压力 1.6 MPa。完整保留工程说明。`,
          },
        ],
      }),
    ),
  ),
}));
let start = performance.now();
s.transaction((p) => {
  p.sections = sections;
});
const create = performance.now() - start;
const before = s.snapshot();
start = performance.now();
s.apply("replace_text", {
  block_id: s.project.sections[60].blocks[20].id,
  expected_revision: 1,
  old_text: "1.6",
  new_text: "1.8",
});
const edit = performance.now() - start;
const after = s.snapshot();
let changed = 0;
for (let i = 0; i < 100; i++)
  for (let j = 0; j < 50; j++)
    if (
      JSON.stringify(before.sections[i].blocks[j]) !==
      JSON.stringify(after.sections[i].blocks[j])
    )
      changed++;
if (changed !== 1) throw Error("Unexpected changed block count");
s.close();
start = performance.now();
s.open(dir);
const reopen = performance.now() - start;
const report = {
  sections: 100,
  blocks: 5000,
  createMs: Math.round(create),
  singleBlockCommitMs: Math.round(edit),
  reopenMs: Math.round(reopen),
  changedBlocks: changed,
  projectBytes: fs.statSync(path.join(dir, "project.json")).size,
  platform: process.platform,
  node: process.version,
};
fs.writeFileSync("artifacts/performance.json", JSON.stringify(report, null, 2));
console.log(report);
s.close();
