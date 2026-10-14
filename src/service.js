import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { Store, Fault, atomic } from "./store.js";
import { importDocx } from "./docx.js";
import { runtime, port, connectionFile } from "./connection.js";
const store = new Store(),
  token = randomBytes(32).toString("hex");
const dist = fileURLToPath(new URL("../dist/", import.meta.url));
fs.mkdirSync(runtime, { recursive: true });

let lastActive = Date.now();
const json = (res, data, status = 200) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
};
async function body(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 80 * 1024 * 1024) throw new Fault("请求超过 80 MB 限制", 413);
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString() || "{}");
}
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://127.0.0.1:" + port);
    if (req.headers.host !== `127.0.0.1:${port}`) {
      json(res, { error: "Invalid host" }, 403);
      return;
    }
    const origin = req.headers.origin;
    if (origin && origin !== `http://127.0.0.1:${port}`) {
      json(res, { error: "Invalid origin" }, 403);
      return;
    }
    if (
      url.pathname.startsWith("/api/") ||
      url.pathname.startsWith("/assets/")
    ) {
      if (
        req.headers.authorization !== "Bearer " + token &&
        url.searchParams.get("token") !== token
      ) {
        json(res, { error: "未授权" }, 401);
        return;
      }
      lastActive = Date.now();
    }
    if (url.pathname === "/api/health") return json(res, { ok: true });
    if (url.pathname === "/api/project") {
      if (!store.project) return json(res, { project: null });
      return json(res, { project: store.snapshot() });
    }
    if (url.pathname === "/api/revision")
      return json(res, {
        id: store.project?.id,
        revision: store.project?.revision || 0,
      });
    if (url.pathname === "/api/tool" && req.method === "POST") {
      const { name, args = {} } = await body(req);
      if (name === "export_project") {
        const bytes = await store.export(args.section_ids);
        const dir = path.join(store.dir, "exports");
        fs.mkdirSync(dir, { recursive: true });
        const dest = path.join(dir, `document-${Date.now()}.zip`);
        fs.writeFileSync(dest, bytes);
        return json(res, { path: dest, bytes: bytes.length });
      }
      if (!store.project) throw new Fault("未打开项目");
      return json(res, store.apply(name, args));
    }
    if (url.pathname === "/api/open" && req.method === "POST") {
      const a = await body(req);
      const p = store.open(a.path);
      atomic(
        path.join(runtime, "last.json"),
        JSON.stringify({ path: store.dir }),
      );
      return json(res, p);
    }
    if (url.pathname === "/api/create" && req.method === "POST") {
      const a = await body(req);
      const imported = a.docx
        ? await importDocx(Buffer.from(a.docx, "base64"), a.filename)
        : null;
      const p = store.create(a.path, a.title, imported);
      atomic(
        path.join(runtime, "last.json"),
        JSON.stringify({ path: store.dir }),
      );
      return json(res, p);
    }
    if (url.pathname === "/api/asset" && req.method === "POST") {
      const a = await body(req);
      return json(res, store.addAsset(Buffer.from(a.data, "base64"), a.name));
    }
    if (url.pathname === "/api/export" && req.method === "POST") {
      const a = await body(req);
      const bytes = await store.export(a.section_ids);
      res.writeHead(200, {
        "Content-Type": "application/zip",
        "Content-Disposition": 'attachment; filename="document-package.zip"',
      });
      return res.end(bytes);
    }
    let file;
    if (url.pathname.startsWith("/assets/")) {
      if (!store.dir) throw new Fault("无项目");
      const rel = decodeURIComponent(url.pathname.slice(1));
      if (!/^assets\/[\w.-]+$/.test(rel)) throw new Fault("非法资源路径");
      file = path.join(store.dir, rel);
    } else {
      file = path.resolve(
        dist,
        "." +
          decodeURIComponent(
            url.pathname === "/" ? "/index.html" : url.pathname,
          ),
      );
      if (!file.startsWith(dist)) throw new Fault("非法路径");
    }
    if (!fs.existsSync(file) || !fs.statSync(file).isFile())
      throw new Fault("Not found", 404);
    const mime =
      {
        ".html": "text/html",
        ".js": "text/javascript",
        ".css": "text/css",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".svg": "image/svg+xml",
        ".gif": "image/gif",
        ".webp": "image/webp",
      }[path.extname(file)] || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": mime,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-src 'none'",
    });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    if (!res.headersSent)
      json(res, { error: e.message }, Number.isInteger(e.code) ? e.code : 400);
    else res.end();
  }
});
server.on("error", (e) => {
  console.error(e.message);
  store.close();
  process.exit(1);
});
server.listen(port, "127.0.0.1", () => {
  try {
    const last = JSON.parse(fs.readFileSync(path.join(runtime, "last.json")));
    store.open(last.path);
  } catch {}
  atomic(
    connectionFile,
    JSON.stringify({
      url: `http://127.0.0.1:${port}`,
      token,
      pid: process.pid,
    }),
  );
  try {
    fs.chmodSync(connectionFile, 0o600);
  } catch {}
  console.log("Agent Document local service started");
});
function stop() {
  store.close();
  server.close(() => process.exit());
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
setInterval(() => {
  if (Date.now() - lastActive > 10 * 60 * 1000) stop();
}, 30000).unref();
