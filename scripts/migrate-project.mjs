import fs from "node:fs";
import path from "node:path";
import { Store } from "../src/store.js";

const [source, destination] = process.argv.slice(2);
if (!source || !destination)
  throw Error(
    "用法: node scripts/migrate-project.mjs <旧项目目录> <新副本目录>",
  );
const from = path.resolve(source),
  to = path.resolve(destination);
if (fs.existsSync(to) || to === from || to.startsWith(from + path.sep))
  throw Error("目标必须是不在源项目内部的全新目录");
fs.cpSync(from, to, {
  recursive: true,
  filter: (item) =>
    ![
      "backups",
      "exports",
      "project.lock",
      "document.sqlite-wal",
      "document.sqlite-shm",
    ].includes(path.basename(item)),
});
const store = new Store();
try {
  const p = store.open(to);
  console.log(
    JSON.stringify(
      {
        path: to,
        id: p.id,
        revision: p.revision,
        sections: p.sections.length,
        report: path.join(to, "migration-report.json"),
      },
      null,
      2,
    ),
  );
} finally {
  store.close();
}
