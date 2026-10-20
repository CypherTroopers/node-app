import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const proof = path.join(root, "dist/ci-desktop-runtime.mjs");
const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--packaged-windows")) {
  throw new Error("Use --packaged-windows to verify the built Windows application.");
}
const packaged = args[0] === "--packaged-windows";
const packagedRoot = path.join(root, "release/win-unpacked");
const executable = packaged
  ? path.join(packagedRoot, "colossusx-node-manager.exe")
  : process.execPath;
const helper = packaged
  ? path.join(packagedRoot, "resources/app.asar.unpacked/dist/windows-pty-host.js")
  : path.join(root, "dist/windows-pty-host.js");
await Promise.all([fs.access(executable), fs.access(helper)]);
const commandArgs = packaged
  ? [proof, "--windows-host", helper]
  : [require.resolve("electron/cli.js"), proof];
await build({
  absWorkingDir: root,
  entryPoints: ["test/desktop-runtime.ts"],
  outfile: proof,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  external: ["@lydell/node-pty"],
});
try {
  const child = spawn(executable, commandArgs, {
    cwd: root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: "inherit",
  });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  });
  if (code !== 0) throw new Error("The embedded desktop runtime proof did not exit successfully.");
} finally {
  await fs.rm(proof, { force: true });
}
