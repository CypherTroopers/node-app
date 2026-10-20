import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
await fs.rm(path.join(root, "dist"), { recursive: true, force: true });
const common = {
  absWorkingDir: root,
  bundle: true,
  format: "esm",
  sourcemap: false,
  metafile: true,
  logLevel: "info",
};
const backend = await build({
  ...common,
  entryPoints: {
    cli: "src/server/cli.ts",
    server: "src/server/app.ts",
    desktop: "desktop/main.ts",
    "transfer-store.worker": "src/cypher/transfer-store.worker.ts",
  },
  outdir: "dist",
  platform: "node",
  target: "node24",
  external: ["electron", "@lydell/node-pty"],
});
for (const file of Object.keys(backend.metafile.inputs)) {
  if (file.startsWith("../") || file.includes("node_modules/openclaw/"))
    throw new Error(`Build input escaped standalone project: ${file}`);
}
const licenses = path.join(root, "assets/runtime-licenses");
await fs.rm(licenses, { recursive: true, force: true });
await fs.mkdir(licenses, { recursive: true });
const packages = new Map();
for (const input of Object.keys(backend.metafile.inputs)) {
  const marker = "node_modules/";
  const start = input.lastIndexOf(marker);
  if (start < 0) continue;
  const parts = input.slice(start + marker.length).split("/");
  const count = parts[0].startsWith("@") ? 2 : 1;
  const packageRoot = path.join(
    root,
    input.slice(0, start + marker.length),
    ...parts.slice(0, count),
  );
  if (packages.has(packageRoot)) continue;
  const metadata = JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8"));
  const directory = path.join(
    licenses,
    `${metadata.name.replaceAll("/", "__")}@${metadata.version}`,
  );
  await fs.mkdir(directory, { recursive: true });
  const notices = (await fs.readdir(packageRoot)).filter((name) =>
    /^(licen[sc]e|copying|notice)([.\-_]|$)/i.test(name),
  );
  for (const notice of notices)
    if ((await fs.stat(path.join(packageRoot, notice))).isFile())
      await fs.copyFile(path.join(packageRoot, notice), path.join(directory, notice));
  packages.set(packageRoot, {
    name: metadata.name,
    version: metadata.version,
    license: metadata.license,
    notices,
  });
}
await fs.writeFile(
  path.join(licenses, "manifest.json"),
  `${JSON.stringify([...packages.values()], null, 2)}\n`,
);
const browser = await build({
  ...common,
  entryPoints: { app: "browser/index.ts" },
  outdir: "dist/ui",
  platform: "browser",
  target: "es2022",
  minify: true,
  loader: { ".png": "dataurl" },
  legalComments: "eof",
});
for (const file of Object.keys(browser.metafile.inputs))
  if (file.startsWith("../") || file.includes("openclaw"))
    throw new Error(`Browser input is not standalone: ${file}`);
await fs.writeFile(
  path.join(root, "dist/ui/index.html"),
  '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ColossusX Node Manager</title><link rel="icon" href="/icon.png"><link rel="stylesheet" href="/app.css"></head><body><main id="app"></main><script type="module" src="/app.js"></script></body></html>\n',
);
await fs.chmod(path.join(root, "dist/cli.js"), 0o755);
console.log("Built independent desktop application, local server, UI, and transfer worker.");
