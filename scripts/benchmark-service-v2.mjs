import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { performance } from "node:perf_hooks";
import JSZip from "jszip";

const root = path.resolve(import.meta.dirname, "..");
const source = path.resolve(
  process.argv[2] ?? path.join(root, "projects/项目-20261014-111032"),
);
const output = path.resolve(
  process.argv[3] ??
    path.join(root, "artifacts/refactor-20261014/performance-service-v2.json"),
);
const old = JSON.parse(
  fs.readFileSync(path.join(source, "project.json"), "utf8"),
);
const originals = old.sections.flatMap((section) => section.blocks);
const table = originals
  .filter((block) => block.type === "table")
  .sort(
    (a, b) => JSON.stringify(b.node).length - JSON.stringify(a.node).length,
  )[0];
function firstText(node) {
  if (node.type === "text" && node.text) return node;
  for (const child of node.content ?? []) {
    const found = firstText(child);
    if (found) return found;
  }
}
const paragraph = originals.find(
  (block) => block.type === "paragraph" && firstText(block.node),
);
const temporary = fs.mkdtempSync(
  path.join(os.tmpdir(), "agentdoc-v2-http-benchmark-"),
);
const copy = path.join(temporary, "project");
fs.mkdirSync(copy);
for (const name of ["project.json", "styles.json", "assets", "original"])
  if (fs.existsSync(path.join(source, name)))
    fs.cpSync(path.join(source, name), path.join(copy, name), {
      recursive: true,
    });
const portProbe = net.createServer();
portProbe.listen(0, "127.0.0.1");
await once(portProbe, "listening");
const port = portProbe.address().port;
await new Promise((resolve) => portProbe.close(resolve));
const child = spawn(process.execPath, [path.join(root, "src/service.js")], {
  cwd: root,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    AGENTDOC_RUNTIME: temporary,
    AGENTDOC_PORT: String(port),
  },
});
let log = "";
child.stdout.on("data", (chunk) => {
  log += chunk;
});
child.stderr.on("data", (chunk) => {
  log += chunk;
});
const connectionFile = path.join(temporary, "connection.json");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const elapsed = (start) => +(performance.now() - start).toFixed(3);
const report = {
  date: new Date().toISOString(),
  source,
  projectCopy: copy,
  node: process.version,
  cpu: os.cpus()[0]?.model,
  scope:
    "Real project copy through authenticated HTTP; includes client JSON serialization, loopback transport, service commit and response parse; excludes WinUI rendering and Word application opening.",
  sections: old.sections.length,
  legacyBlocks: originals.length,
};
try {
  for (let i = 0; i < 150 && !fs.existsSync(connectionFile); i++) {
    if (child.exitCode !== null) throw Error(log);
    await pause(100);
  }
  if (!fs.existsSync(connectionFile)) throw Error(log);
  const connection = JSON.parse(fs.readFileSync(connectionFile));
  const headers = {
    Authorization: "Bearer " + connection.token,
    "Content-Type": "application/json",
  };
  async function api(route, data) {
    const start = performance.now();
    const response = await fetch(connection.url + route, {
      method: data === undefined ? "GET" : "POST",
      headers,
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    const raw = await response.text();
    const value = JSON.parse(raw);
    if (!response.ok) throw Error(response.status + ": " + raw);
    return { value, ms: elapsed(start), bytes: Buffer.byteLength(raw) };
  }
  const tool = (name, args = {}) => api("/api/tool", { name, args });
  const opened = await api("/api/open", { path: copy });
  report.openAndMigrate = { ms: opened.ms, responseBytes: opened.bytes };
  const projectId = opened.value.id;
  report.paragraph = { id: paragraph.id, samples: [] };
  for (let i = 0; i < 5; i++) {
    const current = (await tool("read_block", { block_id: paragraph.id }))
      .value;
    const node = current.node;
    firstText(node).text += " [HTTP测量" + i + "]";
    const updated = await tool("update_block", {
      project_id: projectId,
      block_id: paragraph.id,
      expected_revision: current.revision,
      node,
    });
    if (
      updated.value.changedBlocks.length !== 1 ||
      updated.value.changedBlocks[0].id !== paragraph.id
    )
      throw Error("Unexpected affected paragraph blocks");
    report.paragraph.samples.push({
      ms: updated.ms,
      responseBytes: updated.bytes,
    });
  }
  report.paragraph.medianMs = [...report.paragraph.samples].sort(
    (a, b) => a.ms - b.ms,
  )[2].ms;
  const large = (await tool("read_block", { block_id: table.id })).value;
  const largeRead = await tool("read_section", { section_id: large.sectionId });
  const beforeNode = structuredClone(large.node),
    node = structuredClone(large.node);
  firstText(node).text += " [大型表保存测试]";
  const saved = await tool("update_block", {
    block_id: table.id,
    expected_revision: large.revision,
    node,
  });
  if (
    saved.value.changedBlocks.length !== 1 ||
    saved.value.changedBlocks[0].id !== table.id
  )
    throw Error("Table write changed unexpected block set");
  const restored = await tool("undo_change", {
    change_id: saved.value.changeId,
    expected_revision: saved.value.revision,
  });
  const readback = (await tool("read_block", { block_id: table.id })).value;
  if (JSON.stringify(readback.node) !== JSON.stringify(beforeNode))
    throw Error("Large table undo did not restore content and identity");
  report.largeTable = {
    id: table.id,
    rows: node.content.length,
    cells: node.content.reduce((sum, row) => sum + row.content.length, 0),
    readSectionMs: largeRead.ms,
    sectionResponseBytes: largeRead.bytes,
    editMs: saved.ms,
    responseBytes: saved.bytes,
    undoMs: restored.ms,
    restored: true,
  };
  const revision = (await api("/api/revision")).value.revision;
  const idleStart = performance.now();
  for (let i = 0; i < 100; i++)
    if (
      (await tool("get_changes", { since_revision: revision })).value.changes
        .length
    )
      throw Error("Unexpected idle changes");
  report.idle = {
    requests: 100,
    totalMs: elapsed(idleStart),
    revisionUnchanged: (await api("/api/revision")).value.revision === revision,
  };
  const exported = await tool("export_document", { project_id: projectId });
  const zip = await JSZip.loadAsync(fs.readFileSync(exported.value.path));
  const xml = await zip.file("word/document.xml").async("string");
  if (!xml.includes("HTTP测量4"))
    throw Error("Latest paragraph edit missing from Word export");
  report.docxExport = {
    ms: exported.ms,
    bytes: exported.value.bytes,
    path: exported.value.path,
    documentXmlPresent: true,
    latestEditPresent: true,
  };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({
      report: output,
      paragraphMedianMs: report.paragraph.medianMs,
      tableEditMs: report.largeTable.editMs,
      exportMs: report.docxExport.ms,
      projectCopy: copy,
    }),
  );
} finally {
  child.kill();
  if (child.exitCode === null)
    await Promise.race([once(child, "exit"), pause(4000)]);
}
