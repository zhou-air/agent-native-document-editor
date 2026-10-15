import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store, atomic } from "../src/store.js";
import { ProjectCatalog } from "../src/project-catalog.js";

test("catalog reads legacy and SQLite projects without migrating or switching the writer", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentdoc-catalog-"));
  const runtime = path.join(root, "runtime"), projects = path.join(root, "projects"), legacy = path.join(projects, "旧项目");
  fs.mkdirSync(runtime); fs.mkdirSync(legacy, { recursive: true });
  const legacyContent = JSON.stringify({ title: "旧工程", updatedAt: "2025-01-01T00:00:00Z", sections: [] });
  fs.writeFileSync(path.join(legacy, "project.json"), legacyContent);
  const store = new Store(); t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const current = store.create(path.join(projects, "新项目"), "当前工程");
  atomic(path.join(runtime, "last.json"), JSON.stringify({ path: current.path }));
  const catalog = new ProjectCatalog(runtime, atomic);
  const list = catalog.list(projects);
  assert.equal(list.length, 2); assert(list.every(p => p.available));
  assert.equal(store.dir, current.path); assert.equal(store.project.revision, current.revision);
  assert.equal(fs.readFileSync(path.join(legacy, "project.json"), "utf8"), legacyContent);
  assert(!fs.existsSync(path.join(legacy, "document.sqlite"))); assert(!fs.existsSync(path.join(legacy, "backups")));
});

test("catalog keeps external history across instances, deduplicates paths and reports missing locations", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentdoc-history-"));
  const runtime = path.join(root, "runtime"); fs.mkdirSync(runtime);
  const store = new Store(); t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const project = store.create(path.join(root, "external"), "外部工程");
  const catalog = new ProjectCatalog(runtime, atomic); catalog.remember(project);
  catalog.remember({ ...project, path: path.join(project.path, ".") });
  assert.equal(new ProjectCatalog(runtime, atomic).list(path.join(root, "nonexistent")).length, 1);
  assert.equal(catalog.list()[0].title, "外部工程");
  catalog.remember({ path: path.join(root, "missing"), title: "已移动工程" });
  const missing = catalog.list().find(p => p.title === "已移动工程"); assert.equal(missing.available, false); assert(missing.error);
});
