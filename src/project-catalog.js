import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const key = directory => process.platform === "win32" ? path.resolve(directory).toLowerCase() : path.resolve(directory);
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };

/** Project summaries never open Store, migrate a project, or acquire its writer lock. */
export class ProjectCatalog {
  constructor(runtime, writeAtomic) { this.runtime = runtime; this.writeAtomic = writeAtomic; this.file = path.join(runtime, "recent-projects.json"); }
  records() { const value = readJson(this.file); return Array.isArray(value?.projects) ? value.projects.filter(p => typeof p.path === "string") : []; }
  remember(manifest) {
    const records = this.records().filter(p => key(p.path) !== key(manifest.path));
    records.push({ path: path.resolve(manifest.path), title: manifest.title, updatedAt: manifest.updatedAt, lastOpenedAt: new Date().toISOString() });
    this.writeAtomic(this.file, JSON.stringify({ formatVersion: 1, projects: records }, null, 2));
  }
  list(root) {
    const candidates = new Map();
    const add = record => { if (typeof record?.path === "string") candidates.set(key(record.path), { ...candidates.get(key(record.path)), ...record, path: path.resolve(record.path) }); };
    const last = readJson(path.join(this.runtime, "last.json"));
    add(last);
    for (const record of this.records()) add(record);
    if (root && fs.existsSync(root)) {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const directory = path.resolve(root, entry.name);
        if (fs.existsSync(path.join(directory, "document.sqlite")) || fs.existsSync(path.join(directory, "project.json"))) {
          if (!candidates.has(key(directory))) add({ path: directory });
        }
      }
    }
    return [...candidates.values()].map(record => {
      let db;
      try {
        let summary;
        const database = path.join(record.path, "document.sqlite");
        if (fs.existsSync(database)) {
          db = new DatabaseSync(database, { readOnly: true });
          summary = db.prepare("SELECT title, updated_at AS updatedAt FROM documents LIMIT 1").get();
          if (!summary) throw Error("项目中没有文档");
        } else {
          summary = readJson(path.join(record.path, "project.json"));
          if (!summary) throw Error("项目路径不存在或无法读取");
        }
        const file = fs.existsSync(database) ? database : path.join(record.path, "project.json");
        return { ...record, title: summary.title || record.title || path.basename(record.path), updatedAt: summary.updatedAt || record.updatedAt || fs.statSync(file).mtime.toISOString(), available: true };
      } catch (error) {
        return { ...record, title: record.title || path.basename(record.path), available: false, error: error.message };
      } finally { db?.close(); }
    }).sort((a, b) => String(b.updatedAt || b.lastOpenedAt || "").localeCompare(String(a.updatedAt || a.lastOpenedAt || "")));
  }
}
