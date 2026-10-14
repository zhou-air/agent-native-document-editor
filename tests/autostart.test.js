import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "agentdoc-auto-"));
const demo = path.join(runtime, "project");
fs.cpSync("examples/demo-project", demo, { recursive: true });
const env = {
  ...process.env,
  ELECTRON_RUN_AS_NODE: "1",
  AGENTDOC_RUNTIME: runtime,
  AGENTDOC_PORT: String(49000 + Math.floor(Math.random() * 1000)),
};
const command = process.env.AGENTDOC_TEST_EXECUTABLE || process.execPath;
const script = process.env.AGENTDOC_TEST_MCP || path.resolve("src/mcp.js");
let client;
try {
  client = new Client({ name: "headless-acceptance", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({ command, args: [script], env }),
  );
  assert(!fs.existsSync(path.join(runtime, "connection.json")));
  const reply = await client.callTool({
    name: "open_project",
    arguments: { path: demo },
  });
  assert(!reply.isError, reply.content[0].text);
  assert(fs.existsSync(path.join(runtime, "connection.json")));
  const info = await client.callTool({ name: "project_info", arguments: {} });
  assert(!info.isError);
  const project = JSON.parse(reply.content[0].text),
    b = project.sections[1].blocks[1];
  const miss = await client.callTool({
    name: "replace_text",
    arguments: {
      block_id: b.id,
      expected_revision: b.revision,
      old_text: "不存在的句子",
      new_text: "BAD",
    },
  });
  assert(miss.isError);
  const multi = await client.callTool({
    name: "update_block",
    arguments: {
      block_id: b.id,
      expected_revision: b.revision,
      markdown: "重复 重复",
    },
  });
  assert(!multi.isError);
  const duplicate = await client.callTool({
    name: "replace_text",
    arguments: {
      block_id: b.id,
      expected_revision: b.revision + 1,
      old_text: "重复",
      new_text: "BAD",
    },
  });
  assert(duplicate.isError);
  const report = {
    status: "passed",
    packaged: !!process.env.AGENTDOC_TEST_EXECUTABLE,
    checks: [
      "MCP initialized without GUI or service",
      "open_project automatically launched local service",
      "headless project_info read succeeded",
      "zero-match and multi-match replace_text rejected over real MCP protocol",
    ],
  };
  fs.writeFileSync(
    "artifacts/autostart-results.json",
    JSON.stringify(report, null, 2),
  );
  console.log(report);
} finally {
  await client?.close();
  try {
    process.kill(
      JSON.parse(fs.readFileSync(path.join(runtime, "connection.json"))).pid,
      "SIGTERM",
    );
  } catch {}
}
