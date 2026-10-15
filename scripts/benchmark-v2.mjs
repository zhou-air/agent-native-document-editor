import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import JSZip from "jszip";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) =>
  args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const median = (values) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const elapsed = (start) => +(performance.now() - start).toFixed(3);
const bytes = (value) => Buffer.byteLength(JSON.stringify(value));
function size(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}
function databaseSizes(directory) {
  return Object.fromEntries(
    fs
      .readdirSync(directory)
      .filter((name) => /\.(sqlite|db)(-wal|-shm)?$/.test(name))
      .map((name) => [name, size(path.join(directory, name))]),
  );
}
function firstText(node) {
  if (node.type === "text" && node.text) return node;
  for (const child of node.content ?? []) {
    const result = firstText(child);
    if (result) return result;
  }
}
if (args.includes("--worker")) {
  const mode = option("--worker");
  const projectDirectory = option("--copy");
  const targetId = option("--target");
  const sourceModule =
    mode === "before"
      ? option("--legacy-module")
      : path.join(root, "src/store.js");
  const { Store } = await import(pathToFileURL(sourceModule));
  const store = new Store();
  let start = performance.now();
  const manifest = store.open(projectDirectory);
  const openMs = elapsed(start);
  const initialRevision = store.project.revision;
  const first = store.apply("read_block", { block_id: targetId });
  start = performance.now();
  const section = store.apply("read_section", { section_id: first.sectionId });
  const readSectionMs = elapsed(start);
  const responseBytes = bytes(manifest);
  if (mode === "after") {
    // A single-block write or idle change query must never request a document snapshot.
    store.snapshot = () => {
      throw Error("Unexpected whole-document snapshot on hot path");
    };
  }
  const projectFile = path.join(projectDirectory, "project.json");
  const projectBefore = fs.existsSync(projectFile)
    ? fs.statSync(projectFile)
    : null;
  const samples = [];
  for (let index = 0; index < 5; index++) {
    global.gc?.();
    const current = store.apply("read_block", { block_id: targetId });
    const node = structuredClone(current.node ?? current.content);
    firstText(node).text += " [临时副本测量 " + index + "]";
    const before = databaseSizes(projectDirectory);
    start = performance.now();
    const result = store.apply("update_block", {
      block_id: targetId,
      expected_revision: current.revision,
      node,
    });
    const commitMs = elapsed(start);
    start = performance.now();
    const payload = JSON.stringify(result);
    samples.push({
      commitMs,
      responseSerializeMs: elapsed(start),
      responseBytes: Buffer.byteLength(payload),
      databaseBefore: before,
      databaseAfter: databaseSizes(projectDirectory),
    });
  }
  let idle;
  if (mode === "after") {
    const idleRevision = store.project.revision;
    start = performance.now();
    for (let i = 0; i < 100; i++) {
      const changes = store.apply("get_changes", {
        since_revision: idleRevision,
        limit: 100,
      });
      if (changes.changes.length) throw Error("Idle query returned changes");
    }
    idle = {
      requests: 100,
      totalMs: elapsed(start),
      revisionUnchanged: store.project.revision === idleRevision,
    };
  }
  const projectAfter = fs.existsSync(projectFile)
    ? fs.statSync(projectFile)
    : null;
  const current = store.apply("read_block", { block_id: targetId });
  const report = {
    mode,
    platform: process.platform,
    node: process.version,
    openOrMigrateMs: openMs,
    readSectionMs,
    sectionResponseBytes: bytes(section),
    openResponseBytes: responseBytes,
    samples,
    medianCommitMs: median(samples.map((sample) => sample.commitMs)),
    medianResponseBytes: median(samples.map((sample) => sample.responseBytes)),
    documentRevisionDelta: store.project.revision - initialRevision,
    blockRevisionDelta: current.revision - first.revision,
    blockIdPreserved: current.id === targetId,
    idle,
    projectJsonUnchanged:
      projectBefore && projectAfter
        ? projectBefore.mtimeMs === projectAfter.mtimeMs &&
          projectBefore.size === projectAfter.size
        : !projectBefore && !projectAfter,
    databaseFiles: databaseSizes(projectDirectory),
    maxRssKiB: process.resourceUsage().maxRSS,
    memoryMiB: Object.fromEntries(
      Object.entries(process.memoryUsage()).map(([key, value]) => [
        key,
        +(value / 1048576).toFixed(2),
      ]),
    ),
  };
  store.close();
  start = performance.now();
  const reopened = new Store();
  reopened.open(projectDirectory);
  report.reopenMs = elapsed(start);
  report.persistedId = reopened.apply("read_block", { block_id: targetId }).id;
  report.databaseFilesAfterClose = databaseSizes(projectDirectory);
  reopened.close();
  fs.writeFileSync(option("--result"), JSON.stringify(report, null, 2));
} else {
  const sourceProject = path.resolve(
    option("--project", path.join(root, "projects/项目-20261014-111032")),
  );
  const output = path.resolve(
    option(
      "--output",
      path.join(root, "artifacts/refactor-20261014/performance-v2.json"),
    ),
  );
  const source = JSON.parse(
    fs.readFileSync(path.join(sourceProject, "project.json"), "utf8"),
  );
  const target = source.sections
    .flatMap((section) => section.blocks)
    .find((block) => block.type === "paragraph" && firstText(block.node));
  if (!target)
    throw Error("No paragraph target in the supplied legacy project");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentdoc-v2-benchmark-"));
  const legacyRoot = path.join(temp, "legacy");
  fs.mkdirSync(path.join(legacyRoot, "src"), { recursive: true });
  const archive = path.resolve(
    option(
      "--baseline",
      path.join(root, "artifacts/refactor-20261014/source-before-133324.zip"),
    ),
  );
  const zip = await JSZip.loadAsync(fs.readFileSync(archive));
  for (const name of [
    "src/store.js",
    "src/content.js",
    "src/native-formatting.js",
  ]) {
    if (!zip.file(name)) throw Error("Missing baseline source: " + name);
    fs.writeFileSync(
      path.join(legacyRoot, name),
      await zip.file(name).async("nodebuffer"),
    );
  }
  fs.writeFileSync(path.join(legacyRoot, "package.json"), '{"type":"module"}');
  const archivedDependencies = path.join(
    root,
    "artifacts/refactor-20261014/legacy-baseline/node_modules",
  );
  fs.symlinkSync(
    fs.existsSync(archivedDependencies)
      ? archivedDependencies
      : path.join(root, "node_modules"),
    path.join(legacyRoot, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const report = {
    date: new Date().toISOString(),
    cpu: os.cpus()[0]?.model,
    sourceProject,
    sourceArchive: archive,
    scope:
      "Same-machine real-project copies; five actual single-paragraph commits. Store timings exclude HTTP transport and WinUI rendering. Originals are only read.",
    sections: source.sections.length,
    blocks: source.sections.reduce(
      (sum, section) => sum + section.blocks.length,
      0,
    ),
    legacyProjectBytes: size(path.join(sourceProject, "project.json")),
    legacyStyleMirrorBytes: size(path.join(sourceProject, "styles.json")),
    targetBlockId: target.id,
    temporaryDirectory: temp,
  };
  for (const mode of args.includes("--skip-legacy")
    ? ["after"]
    : ["before", "after"]) {
    const copy = path.join(temp, mode);
    fs.mkdirSync(copy);
    for (const name of ["project.json", "styles.json", "assets", "original"])
      if (fs.existsSync(path.join(sourceProject, name)))
        fs.cpSync(path.join(sourceProject, name), path.join(copy, name), {
          recursive: true,
        });
    const resultFile = path.join(temp, mode + ".json");
    const child = spawnSync(
      process.execPath,
      [
        "--expose-gc",
        fileURLToPath(import.meta.url),
        "--worker",
        mode,
        "--copy",
        copy,
        "--target",
        target.id,
        "--legacy-module",
        path.join(legacyRoot, "src/store.js"),
        "--result",
        resultFile,
      ],
      {
        cwd: root,
        encoding: "utf8",
        windowsHide: true,
        timeout: 180000,
        maxBuffer: 1024 * 1024,
      },
    );
    if (child.status !== 0)
      throw Error(mode + " benchmark failed: " + child.stderr + child.stdout);
    report[mode] = JSON.parse(fs.readFileSync(resultFile));
    console.log(
      mode +
        ": median commit " +
        report[mode].medianCommitMs +
        " ms; response " +
        report[mode].medianResponseBytes +
        " bytes",
    );
  }
  report.improvement = {
    commitSpeedup: report.before
      ? +(report.before.medianCommitMs / report.after.medianCommitMs).toFixed(2)
      : null,
    responseReductionPercent: report.before
      ? +(
          100 *
          (1 -
            report.after.medianResponseBytes /
              report.before.medianResponseBytes)
        ).toFixed(3)
      : null,
    activeDatabaseBytes: Object.entries(report.after.databaseFilesAfterClose)
      .filter(([name]) => !name.endsWith("-shm"))
      .reduce((sum, [, value]) => sum + value, 0),
  };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2));
  console.log("Report: " + output);
}
