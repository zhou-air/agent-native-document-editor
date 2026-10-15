import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import JSZip from "jszip";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function setup({ lastPath } = {}) {
  const runtime = fs.mkdtempSync(
    path.join(os.tmpdir(), "agentdoc-v2-service-"),
  );
  const port = await freePort();
  if (lastPath) fs.writeFileSync(path.join(runtime, "last.json"), JSON.stringify({ path: lastPath }));
  const env = {
    ...process.env,
    AGENTDOC_RUNTIME: runtime,
    AGENTDOC_PORT: String(port),
  };
  const child = spawn(process.execPath, [path.resolve("src/service.js")], {
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (chunk) => {
    log += chunk;
  });
  child.stderr.on("data", (chunk) => {
    log += chunk;
  });
  const connectionPath = path.join(runtime, "connection.json");
  for (let i = 0; i < 150 && !fs.existsSync(connectionPath); i++) {
    if (child.exitCode !== null) throw Error(log);
    await pause(100);
  }
  assert(fs.existsSync(connectionPath), log);
  const connection = JSON.parse(fs.readFileSync(connectionPath));
  const headers = {
    Authorization: "Bearer " + connection.token,
    "Content-Type": "application/json",
  };
  async function request(route, data) {
    const response = await fetch(connection.url + route, {
      headers,
      method: data === undefined ? "GET" : "POST",
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    const value = await response.json();
    return { status: response.status, value };
  }
  async function api(route, data) {
    const { status, value } = await request(route, data);
    assert.equal(status, 200, JSON.stringify(value));
    return value;
  }
  const tool = (name, args = {}) => api("/api/tool", { name, args });
  return {
    runtime,
    env,
    connection,
    headers,
    request,
    api,
    tool,
    async close() {
      child.kill();
      if (child.exitCode === null)
        await Promise.race([once(child, "exit"), pause(4000)]);
    },
  };
}
test("project catalog API lists imported projects without changing the active project and excludes failed imports", async t => {
  const c = await setup(); t.after(() => c.close());
  const root = path.join(c.runtime, "projects");
  const docx = fs.readFileSync(path.resolve("tests/fixtures/engineering.docx")).toString("base64");
  const first = await c.api("/api/create", { path: path.join(root, "one"), title: "按文件名命名", filename: "按文件名命名.docx", docx });
  const exported = await fetch(c.connection.url + '/api/export', {method:'POST',headers:c.headers,body:JSON.stringify({format:'docx',project_id:first.id})});
  const withIdentity = Buffer.from(await exported.arrayBuffer()).toString('base64');
  const second = await c.api("/api/create", { path: path.join(root, "two"), title: "按文件名命名", filename: "按文件名命名.docx", docx: withIdentity, fresh_document: true });
  assert.equal(first.title, "按文件名命名"); assert.equal(second.title, first.title); assert.notEqual(second.path, first.path);
  assert.notEqual(second.id, first.id, 'a new project must not share an archived Word document identity');
  const list = await c.api("/api/projects?root=" + encodeURIComponent(root));
  assert.equal(list.projects.length, 2); assert(list.projects.every(p => p.available && p.lastOpenedAt));
  assert.equal((await c.api("/api/project")).project.path, second.path);
  const failed = await c.request("/api/create", { path: path.join(root, "bad"), title: "失败导入", filename: "bad.docx", docx: Buffer.from("not a docx").toString("base64") });
  assert.equal(failed.status, 400); assert.equal((await c.api("/api/projects?root=" + encodeURIComponent(root))).projects.length, 2);
  assert.equal((await c.api("/api/project")).project.path, second.path);
});

test("connecting for the homepage does not migrate a legacy last project", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdoc-legacy-home-'));
  t.after(() => fs.rmSync(directory, {recursive:true,force:true}));
  fs.writeFileSync(path.join(directory, 'project.json'), JSON.stringify({title:'旧项目列表',sections:[]}));
  const c = await setup({lastPath:directory}); t.after(() => c.close());
  assert.equal((await c.api('/api/project')).project, null);
  const list = await c.api('/api/projects'); assert.equal(list.projects.length, 1); assert.equal(list.projects[0].title, '旧项目列表');
  assert(!fs.existsSync(path.join(directory,'document.sqlite'))); assert(!fs.existsSync(path.join(directory,'backups')));
});

async function events(context, revision, projectId, sectionId) {
  const abort = new AbortController();
  const response = await fetch(
    context.connection.url +
      "/api/events?since_revision=" +
      revision +
      "&project_id=" +
      projectId +
      (sectionId ? "&section_id=" + sectionId : ""),
    { headers: context.headers, signal: abort.signal },
  );
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    close: () => abort.abort(),
    async next(type) {
      const timeout = setTimeout(() => abort.abort(), 5000);
      try {
        while (true) {
          const end = buffer.indexOf("\n\n");
          if (end >= 0) {
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const event = frame.match(/^event: (.*)$/m)?.[1];
            if (event === type)
              return JSON.parse(frame.match(/^data: (.*)$/m)[1]);
          } else {
            const part = await reader.read();
            if (part.done) throw Error("SSE closed before " + type);
            buffer += decoder.decode(part.value, { stream: true });
          }
        }
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

test(
  "v2 HTTP, SSE and real MCP share one revisioned block authority",
  { timeout: 60000 },
  async (t) => {
    const context = await setup();
    const clients = [];
    t.after(async () => {
      for (const client of clients) await client.close();
      await context.close();
    });
    const { api, request, tool, runtime } = context;
    const project = await api("/api/create", {
      path: path.join(runtime, "project"),
      title: "结构化协作测试",
    });
    assert.equal(project.formatVersion, 2);
    assert(
      project.sections.every((section) => !Object.hasOwn(section, "blocks")),
    );
    const sectionId = project.sections[0].id;
    const section = await tool("read_section", { section_id: sectionId });
    const created = await tool("create_block", {
      project_id: project.id,
      section_id: sectionId,
      expected_revision: section.revision,
      markdown: "原始段落",
    });
    const block =
      created.block ??
      created.changedBlocks.find((item) => item.type === "paragraph");
    assert(block?.id);
    assert(!Object.hasOwn(created, "sections"));
    assert.equal(
      (await tool("read_block", { block_id: block.id })).id,
      block.id,
    );

    await t.test(
      "identity guard and compare-and-swap reject stale writes without mutation",
      async () => {
        const rejected = await request("/api/tool", {
          name: "update_block",
          args: {
            project_id: "another-document",
            block_id: block.id,
            expected_revision: block.revision,
            markdown: "错误项目",
          },
        });
        assert.equal(rejected.status, 409);
        const replies = await Promise.all(
          ["并发甲", "并发乙"].map((markdown) =>
            request("/api/tool", {
              name: "update_block",
              args: {
                block_id: block.id,
                expected_revision: block.revision,
                markdown,
              },
            }),
          ),
        );
        assert.deepEqual(
          replies.map((reply) => reply.status).sort(),
          [200, 409],
        );
        const stored = await tool("read_block", { block_id: block.id });
        assert.equal(stored.revision, block.revision + 1);
        assert.match(stored.markdown, /并发[甲乙]/);
      },
    );

    await t.test(
      "SSE sends changed Blocks and replays missed revisions on reconnect",
      async () => {
        const revision = (await api("/api/revision")).revision;
        const stream = await events(context, revision, project.id);
        await stream.next("ready");
        const current = await tool("read_block", { block_id: block.id });
        const changed = await tool("update_block", {
          block_id: block.id,
          expected_revision: current.revision,
          markdown: "事件一",
        });
        const event = await stream.next("change");
        assert.equal(event.revision, changed.revision);
        assert(event.changedBlocks.some((item) => item.id === block.id));
        stream.close();
        const updated = await tool("read_block", { block_id: block.id });
        const second = await tool("update_block", {
          block_id: block.id,
          expected_revision: updated.revision,
          markdown: "事件二",
        });
        const replay = await events(context, changed.revision, project.id);
        assert.equal((await replay.next("change")).revision, second.revision);
        replay.close();
        const page = await tool("get_changes", {
          since_revision: revision,
          limit: 1,
        });
        assert.equal(page.changes.length, 1);
        assert.equal(page.hasMore, true);
        assert.equal(page.changes[0].revision, changed.revision);
      },
    );

    await t.test(
      "MCP lists new tools, locates blocks directly and preserves legacy tool names",
      async () => {
        const client = new Client({
          name: "agentdoc-v2-test",
          version: "2.0.0",
        });
        clients.push(client);
        await client.connect(
          new StdioClientTransport({
            command: process.execPath,
            args: [path.resolve("src/mcp.js")],
            env: context.env,
            stderr: "pipe",
          }),
        );
        const available = new Set(
          (await client.listTools()).tools.map((item) => item.name),
        );
        for (const name of [
          "list_sections",
          "read_section",
          "read_sections",
          "read_block",
          "create_block",
          "update_block",
          "delete_block",
          "move_block",
          "copy_block",
          "create_section",
          "update_section",
          "move_section",
          "delete_section",
          "get_changes",
          "export_document",
          "insert_block",
          "write_section",
          "export_project",
        ])
          assert(available.has(name), name);
        const response = await client.callTool({
          name: "read_block",
          arguments: { block_id: block.id, project_id: project.id },
        });
        assert(!response.isError);
        const current = JSON.parse(response.content[0].text);
        assert.equal(current.id, block.id);
        const update = await client.callTool({
          name: "update_block",
          arguments: {
            block_id: block.id,
            expected_revision: current.revision,
            markdown: "MCP 精准修改",
            project_id: project.id,
          },
        });
        assert(!update.isError, JSON.stringify(update));
        const payload = JSON.parse(update.content[0].text);
        assert(!Object.hasOwn(payload, "sections"));
        assert(Buffer.byteLength(update.content[0].text) < 20000);
        assert.equal(
          (await tool("read_block", { block_id: block.id })).markdown,
          "MCP 精准修改",
        );
        const stale = await client.callTool({
          name: "update_block",
          arguments: {
            block_id: block.id,
            expected_revision: current.revision,
            markdown: "过期",
          },
        });
        assert(stale.isError);
        assert.equal(JSON.parse(stale.content[0].text).code, 409);
        const secondClient = new Client({
          name: "agentdoc-v2-second-agent",
          version: "2.0.0",
        });
        clients.push(secondClient);
        await secondClient.connect(
          new StdioClientTransport({
            command: process.execPath,
            args: [path.resolve("src/mcp.js")],
            env: context.env,
            stderr: "pipe",
          }),
        );
        const shared = await tool("read_block", { block_id: block.id });
        const competing = await Promise.all(
          [client, secondClient].map((agent, index) =>
            agent.callTool({
              name: "update_block",
              arguments: {
                block_id: block.id,
                expected_revision: shared.revision,
                markdown: "MCP 精准修改 " + index,
                project_id: project.id,
              },
            }),
          ),
        );
        assert.equal(competing.filter((reply) => !reply.isError).length, 1);
        assert.equal(
          competing.filter(
            (reply) =>
              reply.isError && JSON.parse(reply.content[0].text).code === 409,
          ).length,
          1,
        );
      },
    );

    await t.test(
      "section-scoped HTTP, MCP and SSE omit other section bodies and report blocks moved out",
      async () => {
        const createdSection = await tool("create_section", {
          title: "大型表格所在章节",
          expected_revision: (await api("/api/revision")).revision,
        });
        const otherSection = createdSection.section;
        const revision = (await api("/api/revision")).revision;
        const stream = await events(context, revision, project.id, sectionId);
        await stream.next("ready");
        const marker = "OTHER_SECTION_TABLE_BODY";
        const largeTable = {
          type: "table",
          content: Array.from({ length: 100 }, () => ({
            type: "tableRow",
            content: Array.from({ length: 8 }, () => ({
              type: "tableCell",
              attrs: { colspan: 1, rowspan: 1 },
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: marker.repeat(8) }],
                },
              ],
            })),
          })),
        };
        const createdTable = await tool("create_block", {
          section_id: otherSection.id,
          expected_revision: otherSection.revision,
          node: largeTable,
        });
        const assertScoped = (change) => {
          assert.equal(change.changedBlocks.length, 0);
          assert(!JSON.stringify(change).includes(marker));
          assert(Buffer.byteLength(JSON.stringify(change)) < 20000);
          for (const section of change.changedSections.filter(
            (item) => item.id !== sectionId,
          )) {
            assert(!Object.hasOwn(section, "blockIds"));
            assert(!Object.hasOwn(section, "entries"));
          }
          assert(!change.block);
        };
        const tableEvent = await stream.next("change");
        assert.equal(tableEvent.revision, createdTable.revision);
        assertScoped(tableEvent);
        const httpPage = await api(
          "/api/changes?since_revision=" +
            revision +
            "&section_id=" +
            sectionId,
        );
        assertScoped(httpPage.changes[0]);
        const globalPage = await tool("get_changes", {
          since_revision: revision,
        });
        assert(
          globalPage.changes[0].changedBlocks.some(
            (item) => item.id === createdTable.block.id,
          ),
        );
        assert(JSON.stringify(globalPage).includes(marker));
        const mcpPage = await clients[0].callTool({
          name: "get_changes",
          arguments: { since_revision: revision, section_id: sectionId },
        });
        assert(!mcpPage.isError);
        assertScoped(JSON.parse(mcpPage.content[0].text).changes[0]);

        const moving = await tool("read_block", { block_id: block.id });
        const destination = await tool("read_section", {
          section_id: otherSection.id,
        });
        const moved = await tool("move_block", {
          block_id: moving.id,
          expected_revision: moving.revision,
          section_id: otherSection.id,
          target_revision: destination.revision,
        });
        const movedEvent = await stream.next("change");
        assert.equal(movedEvent.revision, moved.revision);
        assertScoped(movedEvent);
        assert.deepEqual(movedEvent.removedFromSectionBlockIds, [block.id]);
        assert(
          movedEvent.movedBlocks.some(
            (item) =>
              item.id === block.id &&
              item.fromSectionId === sectionId &&
              item.toSectionId === otherSection.id,
          ),
        );
        stream.close();
        const replay = await events(context, revision, project.id, sectionId);
        assertScoped(await replay.next("change"));
        const replayedMove = await replay.next("change");
        assertScoped(replayedMove);
        assert.deepEqual(replayedMove.removedFromSectionBlockIds, [block.id]);
        replay.close();
        const incoming = await tool("get_changes", {
          since_revision: createdTable.revision,
          section_id: otherSection.id,
        });
        assert(
          incoming.changes[0].changedBlocks.some(
            (item) => item.id === block.id,
          ),
        );
        assert.deepEqual(incoming.changes[0].removedFromSectionBlockIds, []);
      },
    );

    await t.test(
      "DOCX download and legacy ZIP are concrete self-contained outputs",
      async () => {
        const exported = await tool("export_document", {
          project_id: project.id,
        });
        assert.equal(exported.format, "docx");
        const docx = await JSZip.loadAsync(fs.readFileSync(exported.path));
        assert(docx.file("word/document.xml"));
        assert.match(
          await docx.file("word/document.xml").async("string"),
          /MCP 精准修改/,
        );
        const legacy = await tool("export_project", {});
        assert.equal(legacy.format, "zip");
        const zip = await JSZip.loadAsync(fs.readFileSync(legacy.path));
        assert(zip.file("structure.json"));
        const response = await fetch(context.connection.url + "/api/export", {
          method: "POST",
          headers: context.headers,
          body: JSON.stringify({ project_id: project.id, format: "docx" }),
        });
        assert.equal(response.status, 200);
        assert.match(response.headers.get("content-type"), /wordprocessingml/);
        assert(
          (await JSZip.loadAsync(await response.arrayBuffer())).file(
            "word/document.xml",
          ),
        );
      },
    );

    await t.test(
      "SSE reports a project switch instead of mixing documents",
      async () => {
        const revision = (await api("/api/revision")).revision;
        const stream = await events(context, revision, project.id);
        await stream.next("ready");
        const other = await api("/api/create", {
          path: path.join(runtime, "other-project"),
          title: "另一个项目",
        });
        assert.equal((await stream.next("project")).id, other.id);
        stream.close();
        const mismatch = await fetch(
          context.connection.url + "/api/events?project_id=" + project.id,
          { headers: context.headers },
        );
        assert.equal(mismatch.status, 409);
      },
    );
  },
);

test(
  "MCP starts the shared service without a GUI and migrates a copied legacy project",
  { timeout: 30000 },
  async (t) => {
    const runtime = fs.mkdtempSync(
      path.join(os.tmpdir(), "agentdoc-v2-autostart-"),
    );
    const directory = path.join(runtime, "copied-project");
    fs.cpSync(path.resolve("examples/demo-project"), directory, {
      recursive: true,
    });
    const port = await freePort();
    const env = {
      ...process.env,
      AGENTDOC_RUNTIME: runtime,
      AGENTDOC_PORT: String(port),
    };
    const client = new Client({
      name: "agentdoc-v2-autostart",
      version: "2.0.0",
    });
    t.after(async () => {
      await client.close();
      try {
        process.kill(
          JSON.parse(fs.readFileSync(path.join(runtime, "connection.json")))
            .pid,
        );
      } catch {}
    });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [path.resolve("src/mcp.js")],
        env,
        stderr: "pipe",
      }),
    );
    assert(!fs.existsSync(path.join(runtime, "connection.json")));
    const reply = await client.callTool({
      name: "open_project",
      arguments: { path: directory },
    });
    assert(!reply.isError, JSON.stringify(reply));
    const manifest = JSON.parse(reply.content[0].text);
    assert.equal(manifest.formatVersion, 2);
    assert(
      manifest.sections.every((section) => !Object.hasOwn(section, "blocks")),
    );
    assert(fs.existsSync(path.join(directory, "document.sqlite")));
    assert(fs.existsSync(path.join(directory, "project.json")));
    const read = await client.callTool({
      name: "read_section",
      arguments: { section_id: manifest.sections[1].id },
    });
    assert(!read.isError);
    assert(JSON.parse(read.content[0].text).blocks.length > 0);
  },
);
