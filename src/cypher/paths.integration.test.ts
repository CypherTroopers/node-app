import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { CypherNodeManager, type CypherAuthority } from "./manager.js";
import { launchCypherProcess, type CypherProcess } from "./process.js";

const nativeFixture = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
};
// Independently model the native DirectoryFlag's HOME, single-pass os.ExpandEnv, and path.Clean.
function nativePath(value) {
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    value = (process.env.HOME || os.homedir()) + value.slice(1);
  }
  value = value.replace(
    /\$(\{[^}]*\}|[A-Za-z_][A-Za-z0-9_]*|[0-9*#$@!?-])/g,
    (_token, name) => process.env[name.startsWith("{") ? name.slice(1, -1) : name] || "",
  );
  return path.posix.normalize(value).replace(/(.)\/$/, "$1");
}
const dataDir = path.resolve(nativePath(flag("--datadir", "chaindbname")));
const ipc = nativePath(flag("--ipcpath", "cypher.ipc"));
const ipcPath = path.resolve(path.basename(ipc) === ipc ? dataDir : process.cwd(), ipc);
const init = args.includes("init");
fs.appendFileSync(
  process.env.CYPHER_PATH_FIXTURE_CALLS,
  JSON.stringify({ args, dataDir, ipcPath, init }) + "\n",
);
if (init) {
  fs.mkdirSync(path.join(dataDir, "cypher", "chaindata"), { recursive: true });
} else {
  const values = {
    web3_clientVersion: "Cypher/path-fixture",
    eth_chainId: "0x9a249f",
    eth_blockNumber: "0x10",
    net_peerCount: "0x3",
    eth_mining: false,
    eth_hashrate: "0x0",
    eth_accounts: [],
  };
  const server = net.createServer((socket) => {
    let input = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      input += chunk;
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(input.slice(0, newline));
      const reply = Object.hasOwn(values, request.method)
        ? { result: values[request.method] }
        : { error: { code: -32601, message: "Unknown fixture operation" } };
      socket.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, ...reply }) + "\n");
    });
  });
  process.on("SIGINT", () => server.close(() => process.exit(0)));
  fs.mkdirSync(path.dirname(ipcPath), { recursive: true });
  server.listen(ipcPath, () => process.stdout.write("cypher-path-fixture-ready\n"));
}
`;

const supported =
  (process.platform === "linux" && process.arch === "x64") ||
  (process.platform === "darwin" && process.arch === "arm64");
const target =
  process.platform === "darwin"
    ? { script: "colossusX_mac.sh", binary: "cypher-darwin-arm64" }
    : { script: "colossusX_linux.sh", binary: "cypher-linux-amd64" };

it.skipIf(!supported).for(["environment", "home"])(
  "shares %s-expanded native paths with launcher peer files and preserves them on restart",
  async (expansion, { signal, onTestFinished }) => {
    // The standalone app has no core temp helpers; this fixture owns and removes its native processes.
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "cxp-")));
    const owned: Array<{ child: CypherProcess; exited: boolean; exit: Promise<void> }> = [];
    let manager: CypherNodeManager | undefined;
    onTestFinished(async () => {
      try {
        await manager?.close();
      } finally {
        try {
          for (const entry of owned) {
            if (!entry.exited) {
              try {
                process.kill(-entry.child.pid, "SIGKILL");
              } catch (error) {
                if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
                  throw error;
                }
              }
            }
            await entry.exit;
          }
        } finally {
          vi.unstubAllEnvs();
          await fs.rm(root, { recursive: true, force: true });
        }
      }
    });
    const packageDir = path.join(root, "package with spaces");
    const stateRoot = path.join(root, "s $literal");
    const dataDir = path.join(stateRoot, "chain");
    const ipcPath = path.join(stateRoot, "node.ipc");
    const record = path.join(root, "native-calls.jsonl");
    await fs.mkdir(path.join(packageDir, "build", "bin"), { recursive: true });
    await fs.writeFile(
      path.join(packageDir, target.script),
      await fs.readFile(new URL("../../assets/cypher/" + target.script, import.meta.url)),
    );
    await fs.writeFile(path.join(packageDir, "genesis.json"), "{}\n");
    await fs.writeFile(path.join(packageDir, "build", "bin", target.binary), nativeFixture, {
      mode: 0o755,
    });
    vi.stubEnv("CYPHER_PATH_FIXTURE_ROOT", stateRoot);
    vi.stubEnv("CYPHER_PATH_FIXTURE_CALLS", record);
    vi.stubEnv("CYPHER_PATH_FIXTURE_HOME_SUFFIX", path.relative(os.homedir(), dataDir));
    vi.stubEnv(
      "CYPHER_DATADIR",
      expansion === "home"
        ? "~/${CYPHER_PATH_FIXTURE_HOME_SUFFIX}"
        : "${CYPHER_PATH_FIXTURE_ROOT}/chain",
    );
    vi.stubEnv("CYPHER_IPC_PATH", "${CYPHER_PATH_FIXTURE_ROOT}/node.ipc");
    const authority: CypherAuthority = { assertCurrent() {}, signal };
    const createManager = () =>
      new CypherNodeManager({
        assetDir: packageDir,
        rootDir: packageDir,
        stateDir: path.join(root, "runtime"),
        launch: async (options) => {
          const child = await launchCypherProcess(options);
          const exit = Promise.withResolvers<void>();
          const ready = Promise.withResolvers<void>();
          const entry = { child, exited: false, exit: exit.promise };
          owned.push(entry);
          let output = "";
          child.onData((data) => {
            output += data;
            if (output.includes("cypher-path-fixture-ready\n")) ready.resolve();
          });
          child.onExit((code) => {
            entry.exited = true;
            exit.resolve();
            ready.reject(
              new Error("Native path fixture exited before readiness: " + code + "\n" + output),
            );
          });
          const abort = () => ready.reject(signal.reason);
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
          try {
            await ready.promise;
          } finally {
            signal.removeEventListener("abort", abort);
          }
          return child;
        },
      });
    manager = createManager();
    await manager.start(authority);
    const staticFile = path.join(dataDir, "cypher", "static-nodes.json");
    const trustedFile = path.join(dataDir, "cypher", "trusted-nodes.json");
    const staticNodes = await fs.readFile(staticFile, "utf8");
    expect(JSON.parse(staticNodes)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^enode:\/\//)]),
    );
    expect(await fs.readFile(trustedFile, "utf8")).toBe(staticNodes);
    await expect(manager.status()).resolves.toMatchObject({
      dataDir,
      ipcPath,
      state: "running",
      connected: true,
      node: { peerCount: "0x3" },
    });
    const operatorPeers =
      JSON.stringify(["enode://" + "1".repeat(128) + "@127.0.0.1:30303"]) + "\n";
    await fs.writeFile(staticFile, operatorPeers);
    await fs.writeFile(trustedFile, operatorPeers);
    await manager.close();
    manager = createManager();
    await manager.start(authority);
    await expect(manager.status()).resolves.toMatchObject({
      connected: true,
      node: { peerCount: "0x3" },
    });
    expect(await fs.readFile(staticFile, "utf8")).toBe(operatorPeers);
    expect(await fs.readFile(trustedFile, "utf8")).toBe(operatorPeers);
    const calls = (await fs.readFile(record, "utf8"))
      .trim()
      .split("\n")
      .map((line): unknown => JSON.parse(line));
    expect(calls).toEqual([
      expect.objectContaining({ init: true, dataDir }),
      expect.objectContaining({ init: false, dataDir, ipcPath }),
      expect.objectContaining({ init: false, dataDir, ipcPath }),
    ]);
  },
);
