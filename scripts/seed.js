import fs from "node:fs";
import path from "node:path";
import { Store } from "../src/store.js";
import { importDocx } from "../src/docx.js";
const dir = path.resolve(process.argv[2] || "examples/demo-project");
const s = new Store();
s.create(
  dir,
  "演示项目",
  await importDocx(
    fs.readFileSync("tests/fixtures/engineering.docx"),
    "安全设施设计专篇 · 示例.docx",
  ),
);
s.close();
console.log(dir);
