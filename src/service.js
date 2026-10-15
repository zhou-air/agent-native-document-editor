import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { Store, Fault, atomic } from "./store.js";
import { importDocx } from "./docx.js";
import { runtime, port, connectionFile } from "./connection.js";
import { ProjectCatalog } from "./project-catalog.js";

const store = new Store();
const catalog = new ProjectCatalog(runtime, atomic);
const token = randomBytes(32).toString("hex");
const subscriptions = new Set();
fs.mkdirSync(runtime, { recursive: true });
let lastActive = Date.now();

function json(res, data, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data));
}
async function body(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 80 * 1024 * 1024) throw new Fault("请求超过 80 MB 限制", 413);
    chunks.push(chunk);
  }
  let result;
  try {
    result = JSON.parse(Buffer.concat(chunks).toString() || "{}");
  } catch {
    throw new Fault("请求不是有效 JSON");
  }
  if (!result || typeof result !== "object" || Array.isArray(result))
    throw new Fault("请求必须是 JSON 对象");
  return result;
}
function expectProject(args) {
  if (args.project_id !== undefined && args.project_id !== store.project?.id)
    throw new Fault("活动项目已变化，请重新读取；原请求未写入其他项目。", 409);
}
function requireProject() {
  if (!store.project) throw new Fault("未打开项目", 404);
}
function method(req, expected) {
  if (req.method !== expected) throw new Fault("请求方法不支持", 405);
}
function sendEvent(res, event, data, revision) {
  const prefix = Number.isInteger(revision) ? "id: " + revision + "\n" : "";
  // Slow clients reconnect from their revision instead of buffering document content.
  res.write(
    prefix + "event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n",
  );
  if (res.writableLength > 8 * 1024 * 1024) res.destroy();
}
function projectChanged(previousId) {
  if (previousId === store.project?.id) return;
  for (const { res } of subscriptions) {
    sendEvent(res, "project", {
      id: store.project?.id ?? null,
      revision: store.project?.revision ?? 0,
    });
    res.end();
  }
}
function scopeChange(change, sectionId) {
  if (!sectionId) return change;
  const summarize = (section) => {
    if (section.id === sectionId) return section;
    const { blockIds, entries, ...summary } = section;
    return summary;
  };
  const scoped = {
    ...change,
    changedBlocks: (change.changedBlocks || []).filter(
      (block) => block.sectionId === sectionId,
    ),
    changedSections: (change.changedSections || []).map(summarize),
    removedFromSectionBlockIds: (change.movedBlocks || [])
      .filter((block) => block.fromSectionId === sectionId)
      .map((block) => block.id),
  };
  if (scoped.block?.sectionId !== sectionId) delete scoped.block;
  if (scoped.section) scoped.section = summarize(scoped.section);
  return scoped;
}
store.listeners.add((change) => {
  for (const subscription of subscriptions) {
    if (subscription.projectId !== store.project?.id) continue;
    sendEvent(
      subscription.res,
      "change",
      scopeChange(change, subscription.sectionId),
      change.revision ?? change.documentRevision,
    );
  }
});
function subscribe(req, res, url) {
  method(req, "GET");
  requireProject();
  expectProject({
    project_id: url.searchParams.get("project_id") ?? undefined,
  });
  const rawCursor =
    req.headers["last-event-id"] ??
    url.searchParams.get("since_revision") ??
    "0";
  const cursor = Number(rawCursor);
  if (
    !Number.isSafeInteger(cursor) ||
    cursor < 0 ||
    cursor > store.project.revision
  )
    throw new Fault("无效的增量版本游标", 409);
  const sectionId = url.searchParams.get("section_id") || undefined;
  const subscription = { res, projectId: store.project.id, sectionId };
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 1500\n\n");
  let since = cursor;
  // Synchronous bounded-page replay and listener registration cannot interleave a commit.
  while (!res.destroyed) {
    const page = store.apply("get_changes", {
      since_revision: since,
      limit: 100,
      section_id: sectionId,
    });
    if (page.resetRequired) {
      sendEvent(res, "reset", {
        id: store.project.id,
        revision: page.revision,
        reason: "历史游标早于可恢复范围，请重新读取目录和活动章节。",
      });
      res.end();
      return;
    }
    for (const change of page.changes) {
      sendEvent(res, "change", change, change.revision);
      since = change.revision;
    }
    if (!page.hasMore || !page.changes.length) break;
  }
  if (res.destroyed) return;
  subscriptions.add(subscription);
  sendEvent(res, "ready", {
    id: store.project.id,
    revision: store.project.revision,
  });
  res.on("close", () => subscriptions.delete(subscription));
}
async function exportBytes(args, forcedFormat) {
  requireProject();
  const format = forcedFormat ?? args.format ?? "docx";
  if (!["docx", "zip"].includes(format))
    throw new Fault("导出格式必须是 docx 或 zip");
  const projectDirectory = store.dir;
  const bytes =
    format === "zip"
      ? await store.export(args.section_ids)
      : await store.exportDocx(args.section_ids);
  return { bytes, format, projectDirectory };
}
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://127.0.0.1:" + port);
    if (req.headers.host !== "127.0.0.1:" + port)
      throw new Fault("Invalid host", 403);
    const origin = req.headers.origin;
    if (origin && origin !== "http://127.0.0.1:" + port)
      throw new Fault("Invalid origin", 403);
    if (
      req.headers.authorization !== "Bearer " + token &&
      url.searchParams.get("token") !== token
    )
      throw new Fault("未授权", 401);
    lastActive = Date.now();
    if (url.pathname === "/api/health")
      return json(res, { ok: true, apiVersion: 2, capabilities: ["project-catalog", "document-styles"] });
    if (url.pathname === "/api/projects") {
      method(req, "GET");
      return json(res, { projects: catalog.list(url.searchParams.get("root")) });
    }
    if (url.pathname === "/api/project") {
      method(req, "GET");
      return json(res, { project: store.project ? store.manifest() : null });
    }
    if (url.pathname === "/api/revision") {
      method(req, "GET");
      return json(res, {
        id: store.project?.id ?? null,
        revision: store.project?.revision ?? 0,
      });
    }
    if (url.pathname === "/api/events") return subscribe(req, res, url);
    if (url.pathname === "/api/changes") {
      method(req, "GET");
      requireProject();
      expectProject({
        project_id: url.searchParams.get("project_id") ?? undefined,
      });
      return json(
        res,
        store.apply("get_changes", {
          since_revision: Number(url.searchParams.get("since_revision") ?? 0),
          limit: Number(url.searchParams.get("limit") ?? 100),
          section_id: url.searchParams.get("section_id") || undefined,
        }),
      );
    }
    if (url.pathname === "/api/tool") {
      method(req, "POST");
      const { name, args = {} } = await body(req);
      if (!args || typeof args !== "object" || Array.isArray(args))
        throw new Fault("args 必须是 JSON 对象");
      expectProject(args);
      requireProject();
      if (name === "export_project" || name === "export_document") {
        const { bytes, format, projectDirectory } = await exportBytes(
          args,
          name === "export_project" ? "zip" : undefined,
        );
        const dir = path.join(projectDirectory, "exports");
        fs.mkdirSync(dir, { recursive: true });
        const destination = path.join(
          dir,
          "document-" +
            Date.now() +
            "-" +
            randomUUID().slice(0, 8) +
            "." +
            format,
        );
        atomic(destination, bytes);
        return json(res, { path: destination, bytes: bytes.length, format });
      }
      return json(res, store.apply(name, args));
    }
    if (url.pathname === "/api/open" || url.pathname === "/api/create") {
      method(req, "POST");
      const args = await body(req);
      const previousId = store.project?.id;
      let manifest;
      if (url.pathname === "/api/open") manifest = store.open(args.path);
      else {
        const imported = args.docx
          ? await importDocx(Buffer.from(args.docx, "base64"), args.filename)
          : null;
        if (imported && args.fresh_document === true) imported.id = randomUUID();
        manifest = store.create(args.path, args.title, imported);
      }
      atomic(
        path.join(runtime, "last.json"),
        JSON.stringify({ path: store.dir }),
      );
      projectChanged(previousId);
      try { catalog.remember(manifest); } catch (error) { console.error("项目记录未能保存：" + error.message); }
      return json(res, manifest);
    }
    if (url.pathname === "/api/asset") {
      method(req, "POST");
      const args = await body(req);
      expectProject(args);
      requireProject();
      return json(
        res,
        store.addAsset(Buffer.from(args.data, "base64"), args.name),
      );
    }
    if (url.pathname === "/api/export") {
      method(req, "POST");
      const args = await body(req);
      expectProject(args);
      const { bytes, format } = await exportBytes(args);
      res.writeHead(200, {
        "Content-Type":
          format === "zip"
            ? "application/zip"
            : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": 'attachment; filename="document.' + format + '"',
        "Cache-Control": "no-store",
      });
      return res.end(bytes);
    }
    if (url.pathname.startsWith("/assets/")) {
      method(req, "GET");
      requireProject();
      expectProject({
        project_id: url.searchParams.get("project_id") ?? undefined,
      });
      const relative = decodeURIComponent(url.pathname.slice(1));
      if (!/^assets\/[\w.-]+$/.test(relative)) throw new Fault("非法资源路径");
      const file = path.join(store.dir, relative);
      if (!fs.existsSync(file) || !fs.statSync(file).isFile())
        throw new Fault("资源不存在", 404);
      const mime =
        {
          ".png": "image/png",
          ".jpg": "image/jpeg",
          ".jpeg": "image/jpeg",
          ".gif": "image/gif",
          ".webp": "image/webp",
          ".bmp": "image/bmp",
        }[path.extname(file)] ?? "application/octet-stream";
      res.writeHead(200, {
        "Content-Type": mime,
        "X-Content-Type-Options": "nosniff",
      });
      const stream = fs.createReadStream(file);
      stream.on("error", () => res.destroy());
      return stream.pipe(res);
    }
    throw new Fault("Not found", 404);
  } catch (error) {
    if (!res.headersSent)
      json(
        res,
        {
          error: error.message,
          code: Number.isInteger(error.code) ? error.code : 400,
        },
        Number.isInteger(error.code) ? error.code : 400,
      );
    else res.end();
  }
});
server.on("error", (error) => {
  console.error(error.message);
  store.close();
  process.exit(1);
});
server.listen(port, "127.0.0.1", () => {
  try {
    const previousPath = JSON.parse(fs.readFileSync(path.join(runtime, "last.json"))).path;
    // A homepage connection must not migrate a legacy project before the user opens it.
    if (fs.existsSync(path.join(previousPath, "document.sqlite"))) store.open(previousPath);
  } catch {}
  atomic(
    connectionFile,
    JSON.stringify({
      url: "http://127.0.0.1:" + port,
      token,
      pid: process.pid,
      apiVersion: 2,
    }),
  );
  try {
    fs.chmodSync(connectionFile, 0o600);
  } catch {}
  console.log("Agent Document local service started (v2)");
});
function stop() {
  for (const { res } of subscriptions) res.end();
  store.close();
  server.close(() => process.exit());
  setTimeout(() => process.exit(), 1500).unref();
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
setInterval(() => {
  if (subscriptions.size) {
    lastActive = Date.now();
    for (const { res } of subscriptions)
      if (!res.write(": heartbeat\n\n")) res.destroy();
  } else if (Date.now() - lastActive > 10 * 60 * 1000) stop();
}, 15000).unref();
