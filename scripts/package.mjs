import { packager } from "@electron/packager";
const platform = process.argv[2] || process.platform;
if (!["win32", "linux"].includes(platform))
  throw Error("Supported package targets: win32, linux");
const outputs = await packager({
  dir: process.cwd(),
  name: "AgentDocument",
  platform,
  arch: "x64",
  out: "release",
  overwrite: true,
  asar: true,
  prune: true,
  ignore: [/^\/(release|artifacts|tests|\.runtime[^/]*|sample-project)(\/|$)/],
});
console.log(outputs.join("\n"));
