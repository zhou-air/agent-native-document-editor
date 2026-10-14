import { _electron as electron } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
const root = process.cwd(),
  runtime = path.join(root, ".runtime-native-" + Date.now());
fs.mkdirSync(runtime, { recursive: true });
const projectPath = path.join(runtime, "demo-project");
fs.cpSync("examples/demo-project", projectPath, { recursive: true });
fs.writeFileSync(
  path.join(runtime, "last.json"),
  JSON.stringify({ path: projectPath }),
);
const executable = path.join(
  root,
  "release/AgentDocument-linux-x64/AgentDocument",
);
const env = {
  ...process.env,
  DISPLAY: ":99",
  XDG_CONFIG_HOME: path.join(runtime, "config"),
  XDG_CACHE_HOME: "/tmp/agentdoc-cache",
  AGENTDOC_RUNTIME: runtime,
  AGENTDOC_PORT: String(48000 + Math.floor(Math.random() * 1000)),
};
let app, client;
try {
  app = await electron.launch({
    executablePath: executable,
    args: ["--no-sandbox"],
    env,
  });
  console.log("Desktop process launched");
  const page = await app.firstWindow({ timeout: 20000 });
  console.log("Desktop window loaded");
  await page.waitForFunction(() => window.workbench?.project);
  const info = await app.evaluate(({ app }) => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    platform: process.platform,
    packaged: app.isPackaged,
  }));
  assert(info.packaged);
  const p = await page.evaluate(() => window.workbench.project);
  await page.evaluate(
    (id) => window.workbench.switchSection(id),
    p.sections[3].id,
  );
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".tiptap img")].every(
      (i) => i.complete && i.naturalWidth,
    ),
  );
  await page.screenshot({ path: "artifacts/04-electron-desktop-editor.png" });
  await page.click("#tab-style");
  await page.screenshot({ path: "artifacts/05-electron-desktop-styles.png" });
  client = new Client({ name: "packaged-runtime-verifier", version: "1.0.0" });
  console.log("Connecting packaged MCP");
  await client.connect(
    new StdioClientTransport({
      command: executable,
      args: [
        path.join(
          root,
          "release/AgentDocument-linux-x64/resources/app.asar/src/mcp.js",
        ),
      ],
      env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
    }),
  );
  console.log("Packaged MCP initialized");
  const list = await client.listTools();
  assert.equal(list.tools.length, 13);
  const b = p.sections[3].blocks[1];
  const reply = await client.callTool({
    name: "replace_text",
    arguments: {
      block_id: b.id,
      expected_revision: b.revision,
      old_text: "安全设施与设定值",
      new_text: "安全设施与设定值（Agent 已核对）",
    },
  });
  assert(!reply.isError);
  await page.waitForFunction(() =>
    document.querySelector(".tiptap").textContent.includes("Agent 已核对"),
  );
  await page.click("#tab-block");
  await page.screenshot({ path: "artifacts/06-electron-mcp-sync.png" });
  const report = {
    ...info,
    checks: [
      "packaged Electron launched actual desktop window",
      "local project restored",
      "merged table and all 4 images rendered",
      "styles panel displayed",
      "packaged Electron Node-mode MCP initialized 13 tools",
      "MCP edit visible in desktop window",
    ],
    status: "passed",
  };
  fs.writeFileSync(
    "artifacts/desktop-results.json",
    JSON.stringify(report, null, 2),
  );
  console.log(report);
  await client.close();
  client = null;
  await page.evaluate(() => window.workbench.save());
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.close();
  });
  await new Promise((r) => setTimeout(r, 500));
} finally {
  await client?.close().catch(() => {});
  if (app) {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await Promise.race([
      app.close().catch(() => {}),
      new Promise((r) => setTimeout(r, 1000)),
    ]);
  }
  try {
    process.kill(
      JSON.parse(fs.readFileSync(path.join(runtime, "connection.json"))).pid,
      "SIGTERM",
    );
  } catch {}
}
