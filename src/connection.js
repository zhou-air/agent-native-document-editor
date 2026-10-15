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
      if (r.ok) {
        const health = await r.json();
        if (health.apiVersion !== 2) {
          const error = new Error(
            "当前运行的是旧版文档服务，请保存并关闭旧程序后启动新版 WinUI。未向旧服务提交修改。",
          );
          error.code = "EAPI_VERSION";
          throw error;
        }
        return c;
      }
    } catch (error) {
      if (error.code === "EAPI_VERSION") throw error;
    }
    if (i === 0) {
      fs.mkdirSync(runtime, { recursive: true });
      const log = fs.openSync(path.join(runtime, "service.log"), "a");
      const proc = spawn(
        process.execPath,
        [fileURLToPath(new URL("./service.js", import.meta.url))],
        {
          detached: true,
          windowsHide: true,
          stdio: ["ignore", log, log],
        },
      );
      proc.unref();
      fs.closeSync(log);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error("无法启动本地服务，请查看 " + path.join(runtime, "service.log"));
}
export async function request(c, route, data) {
  const r = await fetch(c.url + route, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + c.token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data),
  });
  const result = await r.json();
  if (!r.ok) {
    const e = new Error(result.error);
    e.code = r.status;
    throw e;
  }
  return result;
}
export async function call(c, name, args) {
  return request(c, "/api/tool", { name, args });
}
