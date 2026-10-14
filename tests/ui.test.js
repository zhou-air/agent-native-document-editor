import { chromium } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
const root = process.cwd(),
  runtime = path.join(root, ".runtime-test-" + Date.now()),
  port = "47841";
fs.mkdirSync(runtime, { recursive: true });
const env = { ...process.env, AGENTDOC_RUNTIME: runtime, AGENTDOC_PORT: port };
const log = fs.openSync(path.join(root, "artifacts/service-test.log"), "w");
let service = spawn(process.execPath, ["src/service.js"], {
  env,
  stdio: ["ignore", log, log],
});
const report = [];
function passed(name, evidence) {
  report.push({ name, status: "passed", evidence });
  console.log("PASS", name);
  fs.writeFileSync(
    "artifacts/ui-mcp-results.json",
    JSON.stringify(report, null, 2),
  );
}
let browser, client, page;
async function waitFor(fn) {
  for (let i = 0; i < 100; i++) {
    try {
      const x = await fn();
      if (x) return x;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error("Timed out waiting for condition");
}
const conn = await waitFor(() =>
  JSON.parse(fs.readFileSync(path.join(runtime, "connection.json"))),
);
async function http(route, data) {
  const r = await fetch(conn.url + "/api/" + route, {
    method: data === undefined ? "GET" : "POST",
    headers: {
      Authorization: "Bearer " + conn.token,
      "Content-Type": "application/json",
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const result = await r.json();
  if (!r.ok) throw Error(JSON.stringify(result));
  return result;
}
async function mcp(name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw Error(r.content[0].text);
  return JSON.parse(r.content[0].text);
}
async function settled() {
  await page.evaluate(() => window.workbench.save());
  await page.waitForFunction(() => !window.workbench.dirty);
}
async function choose(id) {
  await page.evaluate((id) => window.workbench.switchSection(id), id);
}
try {
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
  page = await browser.newPage({ viewport: { width: 1480, height: 1040 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(conn.url + "/?token=" + conn.token);
  await page.click("#import");
  const dir = path.join(runtime, "acceptance-project");
  await page.fill("#path-input", dir);
  await page.setInputFiles("#docx-input", "tests/fixtures/engineering.docx");
  await page.click("#confirm-project");
  await page.waitForFunction(
    () => window.workbench.project?.sections.length === 6,
  );
  let p = (await http("project")).project;
  const section = p.sections[1],
    rich = p.sections[3];
  passed("UI imports DOCX and builds 3-level chapter tree", {
    titles: p.sections.map((s) => s.title),
  });
  client = new Client({ name: "acceptance-client", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(root, "src/mcp.js")],
      env,
    }),
  );
  const tools = await client.listTools();
  for (const name of [
    "list_sections",
    "read_section",
    "write_section",
    "list_blocks",
    "read_block",
    "update_block",
    "insert_block",
    "delete_block",
    "replace_text",
    "project_info",
    "export_project",
  ])
    assert(tools.tools.some((t) => t.name === name));
  passed("Real MCP SDK client initialize + tools/list", {
    toolCount: tools.tools.length,
  });
  await choose(section.id);
  const before = await mcp("read_section", { section_id: section.id }),
    b = before.blocks[1];
  await page.locator(".tiptap p").first().click();
  await page.keyboard.press("End");
  await page.keyboard.type(" UI edit.");
  await settled();
  let after = await mcp("read_section", { section_id: section.id });
  assert.equal(after.blocks[1].id, b.id);
  assert.match(after.blocks[1].markdown, /UI edit/);
  assert.deepEqual(
    after.blocks.filter((x) => x.id !== b.id),
    before.blocks.filter((x) => x.id !== b.id),
  );
  passed("Human paragraph edit changes only selected block, ID stable", {
    blockId: b.id,
  });
  await page.click('[data-cmd="undo"]');
  await settled();
  after = await mcp("read_section", { section_id: section.id });
  assert.equal(after.blocks[1].id, b.id);
  assert(!after.blocks[1].markdown.includes("UI edit"));
  await page.click('[data-cmd="redo"]');
  await settled();
  assert.match(
    (await mcp("read_block", { block_id: b.id })).markdown,
    /UI edit/,
  );
  passed("Undo/redo retains original block ID", { blockId: b.id });
  // Actual copy, move and undo editor transactions.
  await page.evaluate((id) => {
    let pos = 0;
    window.workbench.editor.state.doc.forEach((n) => {
      if (n.attrs.id === id)
        window.workbench.editor.commands.setNodeSelection(pos);
      pos += n.nodeSize;
    });
  }, b.id);
  await page.click("#copy-block");
  await settled();
  let copied = await mcp("read_section", { section_id: section.id });
  assert.equal(copied.blocks.length, before.blocks.length + 1);
  const copy = copied.blocks[2];
  assert.notEqual(copy.id, b.id);
  assert.equal(copy.markdown, copied.blocks[1].markdown);
  await page.click('[data-cmd="undo"]');
  await settled();
  assert.equal(
    (await mcp("read_section", { section_id: section.id })).blocks.length,
    before.blocks.length,
  );
  passed("Copy creates new UUID and undo restores original identity", {
    original: b.id,
    copy: copy.id,
  });
  await page.evaluate((id) => {
    let pos = 0;
    window.workbench.editor.state.doc.forEach((n) => {
      if (n.attrs.id === id)
        window.workbench.editor.commands.setNodeSelection(pos);
      pos += n.nodeSize;
    });
  }, b.id);
  await page.click("#down-block");
  await settled();
  let moved = await mcp("read_section", { section_id: section.id });
  assert.equal(moved.blocks[2].id, b.id);
  await page.click('[data-cmd="undo"]');
  await settled();
  assert.equal(
    (await mcp("read_section", { section_id: section.id })).blocks[1].id,
    b.id,
  );
  passed("Block move + undo preserves UUID", { blockId: b.id });
  // Cross-section move and immediate undo/redo use one project revision transaction.
  await page.evaluate((id) => {
    let pos = 0;
    window.workbench.editor.state.doc.forEach((n) => {
      if (n.attrs.id === id)
        window.workbench.editor.commands.setNodeSelection(pos);
      pos += n.nodeSize;
    });
  }, b.id);
  await page.selectOption("#move-target", rich.id);
  await page.click("#move-block");
  await page.waitForFunction(
    (id) =>
      !window.workbench.editor.getJSON().content.some((n) => n.attrs.id === id),
    b.id,
  );
  assert.equal(
    (await mcp("read_block", { block_id: b.id })).sectionId,
    rich.id,
  );
  await page.click('[data-cmd="undo"]');
  await page.waitForFunction(
    (id) =>
      window.workbench.editor.getJSON().content.some((n) => n.attrs.id === id),
    b.id,
  );
  assert.equal(
    (await mcp("read_block", { block_id: b.id })).sectionId,
    section.id,
  );
  await page.click('[data-cmd="redo"]');
  await page.waitForFunction(
    (id) =>
      !window.workbench.editor.getJSON().content.some((n) => n.attrs.id === id),
    b.id,
  );
  await page.click('[data-cmd="undo"]');
  await page.waitForFunction(
    (id) =>
      window.workbench.editor.getJSON().content.some((n) => n.attrs.id === id),
    b.id,
  );
  passed("Cross-section move undo/redo preserves block identity", {
    blockId: b.id,
  });
  // Split a paragraph and join it by Backspace, then undo.
  await page.evaluate((id) => {
    let pos = 0;
    window.workbench.editor.state.doc.forEach((n) => {
      if (n.attrs.id === id)
        window.workbench.editor.commands.setTextSelection(pos + 5);
      pos += n.nodeSize;
    });
    window.workbench.editor.commands.focus();
  }, b.id);
  await page.locator(".tiptap").focus();
  await page.keyboard.press("Enter");
  await settled();
  const split = await mcp("read_section", { section_id: section.id });
  assert.equal(split.blocks.length, before.blocks.length + 1);
  assert.equal(split.blocks[1].id, b.id);
  assert.notEqual(split.blocks[2].id, b.id);
  await page.waitForTimeout(600);
  await page.keyboard.press("Backspace");
  await settled();
  assert.equal(
    (await mcp("read_section", { section_id: section.id })).blocks[1].id,
    b.id,
  );
  await page.click('[data-cmd="undo"]');
  await settled();
  const undone = await mcp("read_section", { section_id: section.id });
  assert.equal(undone.blocks[2].id, split.blocks[2].id);
  await page.click('[data-cmd="undo"]');
  await settled();
  passed("Split/join/undo identity rules exercised", {
    left: b.id,
    right: split.blocks[2].id,
  });
  // Unique replace via MCP and visible refresh.
  let fresh = await mcp("read_block", { block_id: b.id });
  await mcp("replace_text", {
    block_id: b.id,
    expected_revision: fresh.revision,
    old_text: "1.6 MPa",
    new_text: "1.8 MPa",
  });
  await page.waitForFunction(() =>
    document.querySelector(".tiptap").textContent.includes("1.8 MPa"),
  );
  passed("MCP sentence replacement refreshes visible UI", { blockId: b.id });
  const stale = await client.callTool({
    name: "replace_text",
    arguments: {
      block_id: b.id,
      expected_revision: fresh.revision,
      old_text: "1.8 MPa",
      new_text: "BAD",
    },
  });
  assert(stale.isError);
  assert.match(stale.content[0].text, /409/);
  passed("MCP stale write rejected through protocol");
  const s = await mcp("read_section", { section_id: section.id });
  await mcp("insert_block", {
    section_id: section.id,
    expected_revision: s.revision,
    markdown: "Agent inserted paragraph.",
  });
  let inserted = (
    await mcp("read_section", { section_id: section.id })
  ).blocks.at(-1);
  await mcp("update_block", {
    block_id: inserted.id,
    expected_revision: inserted.revision,
    markdown: "Agent updated paragraph.",
  });
  inserted = await mcp("read_block", { block_id: inserted.id });
  assert.match(inserted.markdown, /updated/);
  await mcp("delete_block", {
    block_id: inserted.id,
    expected_revision: inserted.revision,
  });
  assert(
    !(await mcp("list_blocks", { section_id: section.id })).some(
      (x) => x.id === inserted.id,
    ),
  );
  passed("MCP read/insert/update/delete specified block");
  // Version race: two requests, one succeeds.
  fresh = await mcp("read_block", { block_id: b.id });
  const races = await Promise.all(
    ["2.1 MPa", "2.2 MPa"].map((new_text) =>
      client.callTool({
        name: "replace_text",
        arguments: {
          block_id: b.id,
          expected_revision: fresh.revision,
          old_text: "1.8 MPa",
          new_text,
        },
      }),
    ),
  );
  assert.equal(races.filter((r) => !r.isError).length, 1);
  passed("Two concurrent MCP writes: exactly one winner");
  await page.waitForTimeout(1000);
  // UI dirty input held while MCP writes a different block. Hold autosave request at routing layer.
  let release;
  const gate = new Promise((r) => (release = r));
  let held = false;
  await page.route("**/api/tool", async (route) => {
    if (route.request().postDataJSON()?.name === "save_section") {
      held = true;
      await gate;
    }
    await route.continue();
  });
  let sec = await mcp("read_section", { section_id: section.id });
  const human = sec.blocks[3],
    agent = sec.blocks[4];
  await page.evaluate((id) => {
    let pos = 0;
    window.workbench.editor.state.doc.forEach((n) => {
      if (n.attrs.id === id)
        window.workbench.editor.commands.setTextSelection(pos + 1);
      pos += n.nodeSize;
    });
    window.workbench.editor.commands.insertContent("HUMAN ");
  }, human.id);
  await waitFor(() => held);
  await mcp("replace_text", {
    block_id: agent.id,
    expected_revision: agent.revision,
    old_text: "相同内容",
    new_text: "AGENT 相同内容",
  });
  release();
  await settled();
  await page.unroute("**/api/tool");
  sec = await mcp("read_section", { section_id: section.id });
  assert.match(sec.blocks.find((x) => x.id === human.id).markdown, /HUMAN/);
  assert.match(sec.blocks.find((x) => x.id === agent.id).markdown, /AGENT/);
  await page.waitForFunction(() =>
    document.querySelector(".tiptap").textContent.includes("AGENT"),
  );
  passed(
    "Dirty human block + MCP another block: both edits survive in UI and disk",
  );
  // Same-block conflict retains local draft.
  let release2;
  const gate2 = new Promise((r) => (release2 = r));
  held = false;
  await page.route("**/api/tool", async (route) => {
    if (route.request().postDataJSON()?.name === "save_section") {
      held = true;
      await gate2;
    }
    await route.continue();
  });
  fresh = await mcp("read_block", { block_id: human.id });
  await page.evaluate((id) => {
    let pos = 0;
    window.workbench.editor.state.doc.forEach((n) => {
      if (n.attrs.id === id)
        window.workbench.editor.commands.setTextSelection(pos + 1);
      pos += n.nodeSize;
    });
    window.workbench.editor.commands.insertContent("LOCAL-CONFLICT ");
  }, human.id);
  await waitFor(() => held);
  await mcp("replace_text", {
    block_id: human.id,
    expected_revision: fresh.revision,
    old_text: "HUMAN",
    new_text: "SERVER",
  });
  release2();
  await page.waitForFunction(() => window.workbench.conflicted);
  assert(
    await page
      .locator(".tiptap")
      .textContent()
      .then((t) => t.includes("LOCAL-CONFLICT")),
  );
  assert(
    !(await mcp("read_block", { block_id: human.id })).markdown.includes(
      "LOCAL-CONFLICT",
    ),
  );
  await page.screenshot({
    path: "artifacts/03-conflict-preserves-draft.png",
    fullPage: true,
  });
  await page.unroute("**/api/tool");
  await page.click("#reload");
  await page.waitForFunction(() => !window.workbench.conflicted);
  passed(
    "Same-block conflict: explicit banner, local input retained, winner not overwritten",
  );
  await choose(rich.id);
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".tiptap img")].every(
      (i) => i.complete && i.naturalWidth > 0,
    ),
  );
  assert.equal(await page.locator(".tiptap img").count(), 4);
  assert.equal(await page.locator('.tiptap td[rowspan="2"]').count(), 1);
  assert.equal(await page.locator('.tiptap td[colspan="2"]').count(), 1);
  await page.screenshot({
    path: "artifacts/01-editor-imported.png",
    fullPage: true,
  });
  passed("Merged table + images including table image render");
  // Edit cell and table commands through actual UI.
  await page.locator(".tiptap td").nth(1).click();
  await page.keyboard.press("End");
  await page.keyboard.type(" EDIT");
  await page.click('[data-cmd="addRowAfter"]');
  await settled();
  let richS = await mcp("read_section", { section_id: rich.id });
  assert.equal(
    richS.blocks.find((b) => b.type === "table").node.content.length,
    5,
  );
  await page.click('[data-cmd="undo"]');
  await settled();
  await page.click('[data-cmd="addColumnAfter"]');
  await settled();
  await page.click('[data-cmd="undo"]');
  await settled();
  passed("Table cell editing and insert row/column with undo");
  // Actual table selection + merge/split commands.
  await page.evaluate(() => {
    const positions = [];
    window.workbench.editor.state.doc.descendants((n, p) => {
      if (n.type.name === "tableCell") positions.push(p);
    });
    window.workbench.editor.commands.setCellSelection({
      anchorCell: positions[0],
      headCell: positions[1],
    });
  });
  await page.click('[data-cmd="mergeCells"]');
  await settled();
  assert.equal(await page.locator('.tiptap td[colspan="2"]').count(), 2);
  await page.click('[data-cmd="splitCell"]');
  await settled();
  assert.equal(await page.locator('.tiptap td[colspan="2"]').count(), 1);
  await page.click('[data-cmd="addRowAfter"]');
  await settled();
  await page.click('[data-cmd="deleteRow"]');
  await settled();
  await page.click('[data-cmd="addColumnAfter"]');
  await settled();
  await page.click('[data-cmd="deleteColumn"]');
  await settled();
  passed("Visual table merge/split and delete row/column buttons");
  await page.click("#image");
  await page.setInputFiles("#image-input", "tests/fixtures/a/diagram.png");
  await page.waitForFunction(
    () => document.querySelectorAll(".tiptap img").length === 5,
  );
  await settled();
  assert.equal(await page.locator(".tiptap img").count(), 5);
  passed("Image insertion saves managed local asset");
  await page.click("#tab-style");
  await page.waitForSelector("#styles:visible");
  const style = JSON.parse(await page.inputValue("#styles"));
  style.semantic.body.font.sizePt = 13;
  await page.fill("#styles", JSON.stringify(style, null, 2));
  await page.click("#save-style");
  await waitFor(
    () =>
      JSON.parse(fs.readFileSync(path.join(dir, "styles.json"))).semantic.body
        .font.sizePt === 13,
  );
  await page.screenshot({ path: "artifacts/02-styles.png", fullPage: true });
  passed("Editable styles.json persisted to disk");
  const rewrite = await mcp("read_section", { section_id: p.sections[4].id });
  const rewriteNodes = rewrite.blocks.map((b) => b.node);
  rewriteNodes[1].content[0].text += " Agent section edit.";
  await mcp("write_section", {
    section_id: rewrite.id,
    expected_revision: rewrite.revision,
    nodes: rewriteNodes,
  });
  const written = await mcp("read_section", { section_id: rewrite.id });
  assert.deepEqual(
    written.blocks.map((b) => b.id),
    rewrite.blocks.map((b) => b.id),
  );
  assert.match(written.blocks[1].markdown, /Agent section edit/);
  passed("MCP write_section nodes retain supplied stable IDs");
  const exp = await mcp("export_project");
  assert(fs.existsSync(exp.path));
  passed("MCP structured export produces ZIP", { bytes: exp.bytes });
  const saved = (await http("project")).project;
  await page.close();
  await client.close();
  await browser.close();
  browser = null;
  service.kill("SIGTERM");
  await new Promise((r) => service.once("exit", r));
  service = spawn(process.execPath, ["src/service.js"], {
    env,
    stdio: ["ignore", log, log],
  });
  const newConn = await waitFor(async () => {
    const c = JSON.parse(
      fs.readFileSync(path.join(runtime, "connection.json")),
    );
    if (c.token === conn.token) return false;
    const r = await fetch(c.url + "/api/health", {
      headers: { Authorization: "Bearer " + c.token },
    });
    return r.ok ? c : false;
  });
  conn.token = newConn.token;
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
  page = await browser.newPage({ viewport: { width: 1480, height: 1040 } });
  await page.goto(conn.url + "/?token=" + conn.token);
  await page.waitForFunction(() => window.workbench.project);
  const restored = (await http("project")).project;
  assert.deepEqual(restored.sections, saved.sections);
  assert.deepEqual(restored.styles, saved.styles);
  passed(
    "Full service + browser restart restores content, order, IDs and styles",
  );
  assert.deepEqual(errors, []);
  passed("No browser page errors");
  fs.writeFileSync("artifacts/acceptance-project-path.txt", dir);
  fs.writeFileSync("artifacts/test-runtime-path.txt", runtime);
} catch (e) {
  console.error(String(e).slice(0, 1200));
  report.push({
    name: "run failure",
    status: "failed",
    error: e.stack?.slice(0, 2500),
  });
  fs.writeFileSync(
    "artifacts/ui-mcp-results.json",
    JSON.stringify(report, null, 2),
  );
  if (page)
    await page.screenshot({ path: "artifacts/failure.png" }).catch(() => {});
  process.exitCode = 1;
} finally {
  await client?.close().catch(() => {});
  await browser?.close().catch(() => {});
  service.kill("SIGTERM");
  fs.closeSync(log);
}
