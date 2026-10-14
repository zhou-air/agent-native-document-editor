import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
export const runtime =
  process.env.AGENTDOC_RUNTIME ||
  path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), ".local", "share"),
    "AgentDocument",
  );
export const port = Number(process.env.AGENTDOC_PORT || 47831);
export const connectionFile = path.join(runtime, "connection.json");
export async function connect() {
  for (let i = 0; i < 80; i++) {
    try {
      const c = JSON.parse(fs.readFileSync(connectionFile));
      const r = await fetch(c.url + "/api/health", {
        headers: { Authorization: "Bearer " + c.token },
        signal: AbortSignal.timeout(600),
      });
      if (r.ok) return c;
    } catch {}
    if (i === 0) {
      fs.mkdirSync(runtime, { recursive: true });
      const log = fs.openSync(path.join(runtime, "service.log"), "a");
      const proc = spawn(
        process.execPath,
        [fileURLToPath(new URL("./service.js", import.meta.url))],
        {
          detached: true,
          stdio: ["ignore", log, log],
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        },
      );
      proc.unref();
      fs.closeSync(log);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error("无法启动本地服务，请查看 " + path.join(runtime, "service.log"));
}
export async function call(c, name, args) {
  const r = await fetch(c.url + "/api/tool", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + c.token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name, args }),
  });
  const data = await r.json();
  if (!r.ok) {
    const e = new Error(data.error);
    e.code = r.status;
    throw e;
  }
  return data;
}
