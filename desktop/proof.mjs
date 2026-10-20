import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const root = fileURLToPath(new URL("../", import.meta.url));
const executable = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(root, "release/linux-unpacked/colossusx-node-manager");
const proofParent = path.join(root, "artifacts/proof");
await fs.mkdir(proofParent, { recursive: true });
const proof = await fs.mkdtemp(path.join(proofParent, "desktop-"));
const profile = path.join(proof, "profile");
await fs.mkdir(profile);
const report = { executable: path.relative(root, executable), checks: [], screenshots: [] };
let application;
try {
  application = await electron.launch({
    executablePath: executable,
    args: [
      // The QA host runs as root. The shipped application never sets this flag.
      ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []),
      `--user-data-dir=${profile}`,
      "--disable-gpu",
    ],
    cwd: root,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" },
    timeout: 30_000,
  });
  const page = await application.firstWindow();
  await page.locator("#cypher-tab-node").waitFor();
  await page.waitForFunction(() => window.location.hash === "");
  assert.deepEqual(
    (await page.locator('[role="tab"]').allTextContents()).map((text) => text.trim()),
    ["Overview", "Node", "Wallets", "Send", "Mining", "Explorer"],
  );
  const runtime = await application.evaluate(({ app, BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    const preferences = window.webContents.getLastWebPreferences();
    return {
      packaged: app.isPackaged,
      appPath: app.getAppPath(),
      userData: app.getPath("userData"),
      version: process.versions,
      nodeIntegration: preferences.nodeIntegration,
      contextIsolation: preferences.contextIsolation,
      sandbox: preferences.sandbox,
      webSecurity: preferences.webSecurity,
      windowCount: BrowserWindow.getAllWindows().length,
    };
  });
  assert.equal(runtime.packaged, true);
  assert.equal(path.resolve(runtime.userData), path.resolve(profile));
  assert.equal(runtime.nodeIntegration, false);
  assert.equal(runtime.contextIsolation, true);
  assert.equal(runtime.sandbox, true);
  assert.equal(runtime.webSecurity, true);
  assert.equal(runtime.windowCount, 1);
  assert.match(runtime.appPath, /app\.asar$/);
  assert.deepEqual(
    await page.evaluate(() => ({ require: typeof window.require, process: typeof window.process })),
    { require: "undefined", process: "undefined" },
  );
  report.runtime = {
    electron: runtime.version.electron,
    node: runtime.version.node,
    chrome: runtime.version.chrome,
    packaged: runtime.packaged,
    isolatedRenderer: true,
  };
  report.checks.push(
    "Packaged application opens all six tabs using its embedded Electron/Node runtime and isolated renderer.",
  );
  const nativeExists = await fs.stat(path.join(profile, "runtime/native")).then(
    () => true,
    (error) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
  assert.equal(nativeExists, false);
  report.checks.push("Opening the packaged application does not download or start native nodes.");

  const workerProof = await application.evaluate(
    async ({ app }, filename) => {
      const { Worker } = process.getBuiltinModule("node:worker_threads");
      const path = process.getBuiltinModule("node:path");
      const { pathToFileURL } = process.getBuiltinModule("node:url");
      const worker = new Worker(
        pathToFileURL(path.join(app.getAppPath(), "dist/transfer-store.worker.js")),
        {
          workerData: { filename },
        },
      );
      let next = 0;
      const pending = new Map();
      const exit = new Promise((resolve, reject) => {
        worker.once("exit", (code) =>
          code === 0 ? resolve() : reject(new Error(`Worker exit ${code}`)),
        );
        worker.once("error", reject);
      });
      worker.on("message", (message) => {
        if (message.type === "admission") {
          const gate = new Int32Array(message.gate);
          Atomics.store(gate, 0, 1);
          Atomics.notify(gate, 0);
        } else {
          const request = pending.get(message.id);
          if (!request) return;
          pending.delete(message.id);
          if (message.type === "error") request.reject(new Error(message.message));
          else request.resolve(message.result);
        }
      });
      worker.on("error", (error) => {
        for (const request of pending.values()) request.reject(error);
        pending.clear();
      });
      const request = (command) =>
        new Promise((resolve, reject) => {
          const id = ++next;
          pending.set(id, { resolve, reject });
          worker.postMessage({ id, command });
        });
      try {
        const record = {
          requestId: "desktop-packaging-proof",
          quoteId: "desktop-proof-quote",
          nodeKey: "desktop-proof.ipc",
          network: {
            chainId: "0x9a249f",
            genesisHash: `0x${"a".repeat(64)}`,
            currency: "CLX",
            decimals: 18,
          },
          from: `0x${"1".repeat(40)}`,
          to: `0x${"2".repeat(40)}`,
          amount: "0.000000000000000001",
          value: "0x1",
          nonce: "0x0",
          gas: "0x5208",
          gasPrice: "0x1",
          estimatedFee: "0.000000000000021",
          hash: `0x${"b".repeat(64)}`,
          status: "unknown",
          finalitySupported: null,
          blockNumber: null,
          actualFee: null,
          errorCode: null,
          createdAt: 100,
          updatedAt: 100,
        };
        await request({ type: "insert", record });
        const saved = await request({ type: "get", requestId: record.requestId });
        await request({ type: "close" });
        await exit;
        return { requestId: saved.requestId, hash: saved.hash, status: saved.status };
      } finally {
        await worker.terminate();
      }
    },
    path.join(proof, "desktop-worker.sqlite"),
  );
  assert.equal(workerProof.requestId, "desktop-packaging-proof");
  assert.equal(workerProof.status, "unknown");
  report.checks.push(
    "Actual packaged worker loads node:sqlite and durably saves a synthetic transfer under Electron.",
  );
  await fs.rm(path.join(proof, "desktop-worker.sqlite"));

  await page.locator("#cypher-tab-node").click();
  await page.locator("#cypher-panel-node").waitFor({ state: "visible" });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].map((image) => image.decode()));
  });
  await page.screenshot({ path: path.join(proof, "packaged-node.png"), animations: "disabled" });
  report.screenshots.push("packaged-node.png");

  const initialOrigin = new URL(page.url()).origin;
  await page.evaluate(() => {
    window.open("file:///tmp/cypher-desktop-disallowed", "_blank");
  });
  assert.equal(
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
    1,
  );
  const navigationPrevented = await application.evaluate(async ({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    return new Promise((resolve) => {
      contents.once("will-navigate", (event) => resolve(event.defaultPrevented));
      void contents
        .executeJavaScript("location.href = 'https://example.invalid/cypher-proof'")
        .catch(() => {});
    });
  });
  assert.equal(navigationPrevented, true);
  assert.equal(new URL(page.url()).origin, initialOrigin);
  report.checks.push(
    "Untrusted new windows and navigation are blocked at the real desktop boundary.",
  );

  const child = application.process();
  const exited = new Promise((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  const result = await exited;
  assert.equal(result.code, 0);
  application = undefined;
  await assert.rejects(fetch(`${initialOrigin}/`));
  report.checks.push(
    "Closing the application exits successfully and closes its owned loopback service.",
  );
  await fs.writeFile(path.join(proof, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ proof, report }, null, 2));
} finally {
  if (application) await application.close();
  await fs.rm(profile, { recursive: true, force: true });
}
