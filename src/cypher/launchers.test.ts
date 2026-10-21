import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const execute = promisify(execFile);
const peers = [
  "enode://e10a90e9c7d077002d4d56b88943b8dfbca1d6490bb92c8202e6acb68ef23b521bf187fb40c07eed2f453f3782e8c53ca5a4ec1d34a4454960143501df8c4b95@13.140.169.170:6000",
  "enode://0c8a37a7803c358d8ae68784ef247a0c8b4df542d925b23491dd92f4c2172a146a124171ec5bbdcc2e5932e4cead917505ce3b5dbd72155a78e830ebd8e37b07@13.140.169.170:6001",
  "enode://65ebdea1e99c440bb5463b68565e7422ab332ef8d1472daa956d23b70245ef9703c23ea110291eeb6fe0b60c7e55fed08f76e71fb980ae9b3e2fe583a115e7f3@13.140.169.170:6002",
  "enode://c7a724e53dc21ff034e628bb4e50d720e6bbc276bd17cc15cc9a28149a5f0a6bd90c0e50f862f5546fa9bc153c7ea818cdf3d133d06356e76b99726754a6b3da@13.140.169.170:6003",
  "enode://a99ba2027de40c50220e45af60698d7e04237c128258065261fae82cef723837f00ce8611c3164b9efdfc15f0480a308ac65058db9a3abdf83aae05604c9a495@13.140.169.170:6004",
  "enode://8a3aad9282f773ddd38b05516c2c5847ef168b8b5095f57312a458e0a5b358655cb971d1ba193999b0454fc4ae5642f31c6f6bce311a8da11b0a6d9940719a5e@13.140.169.170:6005",
  "enode://7eb6bd844e05f64114ea6e6f06ae04e075df0a8a6d783620344f3535df2f2115ad2ad09dab69cf3515ee2d0ac50379c0825a0abfa5a50216d8e4b97823acbd67@13.140.169.170:6006",
];
const targets =
  process.platform === "win32"
    ? [{ script: "colossusX_windows.ps1", binary: "cypher.exe", windows: true, bootnodes: peers }]
    : [
        {
          script: "colossusX_linux.sh",
          binary: "cypher-linux-amd64",
          windows: false,
          bootnodes: peers,
        },
        {
          script: "colossusX_mac.sh",
          binary: "cypher-darwin-arm64",
          windows: false,
          bootnodes: peers,
        },
      ];
const tempDirs = new Set<string>();
let compiledFixture = "";
let compilerDirectory = "";

// The standalone app owns these isolated external-process fixtures; it has no core temp helpers.
afterEach(async () => {
  await Promise.all(
    [...tempDirs].map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
  tempDirs.clear();
});
beforeAll(async () => {
  if (process.platform !== "win32") return;
  compilerDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "cypher-launcher-compiler-"));
  const source = path.join(compilerDirectory, "Fixture.cs");
  compiledFixture = path.join(compilerDirectory, "cypher.exe");
  await fs.writeFile(
    source,
    `using System;
using System.IO;
using System.Text;
class Fixture {
  static int Main(string[] args) {
    File.AppendAllText(Environment.GetEnvironmentVariable("CYPHER_FIXTURE_RECORD"), Convert.ToBase64String(Encoding.UTF8.GetBytes(String.Join("\\0", args))) + "\\n");
    if (Array.IndexOf(args, "init") >= 0) {
      if (Environment.GetEnvironmentVariable("CYPHER_FIXTURE_INIT_FAIL") == "1") return 23;
      Directory.CreateDirectory(Path.Combine(args[Array.IndexOf(args, "--datadir") + 1], "cypher", "chaindata"));
    } else if (Environment.GetEnvironmentVariable("CYPHER_FIXTURE_NODE_FAIL") == "1") return 29;
    return 0;
  }
}`,
  );
  const compiler = path.join(
    process.env.WINDIR ?? "C:\\Windows",
    "Microsoft.NET",
    "Framework64",
    "v4.0.30319",
    "csc.exe",
  );
  await execute(compiler, ["/nologo", "/target:exe", `/out:${compiledFixture}`, source]);
});
afterAll(async () => {
  if (compilerDirectory) await fs.rm(compilerDirectory, { recursive: true, force: true });
});

async function fixture(target: (typeof targets)[number]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cypher-launcher-"));
  tempDirs.add(root);
  const packageDir = path.join(root, "package with spaces");
  const binDir = path.join(packageDir, "build", "bin");
  const dataDir = path.join(root, "state with spaces", "chain");
  const record = path.join(root, "calls");
  await fs.mkdir(binDir, { recursive: true });
  await fs.writeFile(
    path.join(packageDir, target.script),
    await fs.readFile(new URL(`../../assets/cypher/${target.script}`, import.meta.url)),
  );
  await fs.writeFile(path.join(packageDir, "genesis.json"), "{}\n");
  const executable = path.join(binDir, target.binary);
  if (target.windows) {
    await fs.copyFile(compiledFixture, executable);
  } else {
    await fs.writeFile(
      executable,
      `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CYPHER_FIXTURE_RECORD, Buffer.from(args.join("\\0")).toString("base64") + "\\n");
if (args.includes("init")) {
  if (process.env.CYPHER_FIXTURE_INIT_FAIL === "1") process.exit(23);
  fs.mkdirSync(path.join(args[args.indexOf("--datadir") + 1], "cypher", "chaindata"), { recursive: true });
} else if (process.env.CYPHER_FIXTURE_NODE_FAIL === "1") process.exit(29);
`,
      { mode: 0o755 },
    );
  }
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.toUpperCase().startsWith("CYPHER_") && key.toUpperCase() !== "PATH",
    ),
  );
  const env = {
    ...inherited,
    PATH: process.env.PATH ?? process.env.Path ?? "",
    CYPHER_DATADIR: dataDir,
    CYPHER_FIXTURE_RECORD: record,
  };
  const run = (overrides: NodeJS.ProcessEnv = {}, extraArgs: string[] = []) =>
    execute(
      target.windows ? "powershell.exe" : process.platform === "darwin" ? "/bin/bash" : "bash",
      target.windows
        ? [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            path.join(packageDir, target.script),
            ...extraArgs,
          ]
        : [path.join(packageDir, target.script), ...extraArgs],
      { cwd: root, env: { ...env, ...overrides }, timeout: 10_000 },
    );
  const calls = async () =>
    (await fs.readFile(record, "utf8"))
      .trim()
      .split(/\r?\n/)
      .map((line) => Buffer.from(line, "base64").toString().split("\0"));
  return { root, packageDir, dataDir, record, run, calls };
}
const option = (args: string[], name: string) => args[args.indexOf(name) + 1];

for (const target of targets) {
  describe(target.script, () => {
    it(
      "starts the direct network without relay resources and preserves existing chain and peer files on restart",
      async () => {
        const app = await fixture(target);
        await app.run();
        const [init, startup] = await app.calls();
        expect(init).toEqual([
          "--datadir",
          app.dataDir,
          "init",
          target.windows ? path.join(app.packageDir, "genesis.json") : "./genesis.json",
        ]);
        expect(startup).toBeDefined();
        const args = startup!;
        expect(option(args, "--networkid")).toBe("10101919");
        expect(option(args, "--bootnodes")).toBe(target.bootnodes.join(","));
        for (const [flag, value] of Object.entries({
          "--verbosity": target.script === "colossusX_linux.sh" ? "4" : "1",
          "--rnetport": "7200",
          "--syncmode": "full",
          "--ws.addr": "0.0.0.0",
          "--ws.port": "9251",
          "--ws.origins": "*",
          "--http.addr": "0.0.0.0",
          "--http.port": "8000",
          "--http.api": "eth,web3,net,txpool",
          "--http.corsdomain": "*",
          "--port": "6000",
          "--gcmode": "archive",
          "--datadir": app.dataDir,
        }))
          expect(option(args, flag)).toBe(value);
        expect(args).toEqual(expect.arrayContaining(["--ws", "--http", "--metrics", "console"]));
        expect(args.some((arg) => arg.includes("browser.public-relay"))).toBe(false);
        expect(args.filter((arg) => arg === "--allow-insecure-unlock")).toHaveLength(1);
        expect(args).not.toContain("--nat");
        expect(args.at(-1)).toBe("console");
        const peerDir = path.join(app.dataDir, "cypher");
        const staticFile = path.join(peerDir, "static-nodes.json");
        const trustedFile = path.join(peerDir, "trusted-nodes.json");
        const staticNodes = await fs.readFile(staticFile, "utf8");
        expect(JSON.parse(staticNodes)).toEqual(peers);
        expect(await fs.readFile(trustedFile, "utf8")).toBe(staticNodes);
        const customStatic = JSON.stringify([peers[2]]) + "\n";
        const customTrusted = JSON.stringify([peers[3]]) + "\n";
        await fs.writeFile(staticFile, customStatic);
        await fs.writeFile(trustedFile, customTrusted);
        await app.run();
        const restarted = await app.calls();
        expect(restarted).toHaveLength(3);
        expect(restarted[2]).toEqual(args);
        expect(await fs.readFile(staticFile, "utf8")).toBe(customStatic);
        expect(await fs.readFile(trustedFile, "utf8")).toBe(customTrusted);
        // Cold Windows process admission plus restart can exceed Vitest's 5s default.
        // Each of the two execFile calls remains bounded to 10s.
      },
      target.windows ? 30_000 : undefined,
    );

    it("does not start the node after genesis initialization fails", async () => {
      const app = await fixture(target);
      await expect(app.run({ CYPHER_FIXTURE_INIT_FAIL: "1" })).rejects.toMatchObject({ code: 23 });
      const calls = await app.calls();
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain("init");
    });

    it("keeps the app's optional IPC, RPC binding, and headless settings", async () => {
      const app = await fixture(target);
      await app.run(
        {
          CYPHER_BOOTNODE_HOST: "[2001:db8::42]",
          CYPHER_IPC_PATH: "custom.ipc",
          CYPHER_RPC_BIND: "127.0.0.2",
          CYPHER_WS_BIND: "127.0.0.3",
          CYPHER_RPC_ENABLED: "0",
          CYPHER_HEADLESS: "1",
        },
        ["--fixture-label", "value with spaces"],
      );
      const [, startup] = await app.calls();
      expect(option(startup!, "--ipcpath")).toBe("custom.ipc");
      expect(option(startup!, "--http.addr")).toBe("127.0.0.2");
      expect(option(startup!, "--ws.addr")).toBe("127.0.0.3");
      expect(startup).not.toContain("--http");
      expect(startup).not.toContain("--ws");
      expect(startup).not.toContain("console");
      expect(option(startup!, "--bootnodes")).toBe(
        peers.map((peer) => peer.replace("13.140.169.170", "[2001:db8::42]")).join(","),
      );
      expect(startup!.slice(-2)).toEqual(["--fixture-label", "value with spaces"]);
      expect(
        JSON.parse(
          await fs.readFile(path.join(app.dataDir, "cypher", "static-nodes.json"), "utf8"),
        ),
      ).toEqual(peers.map((peer) => peer.replace("13.140.169.170", "[2001:db8::42]")));
    });

    it("propagates a native node startup failure", async () => {
      const app = await fixture(target);
      await expect(app.run({ CYPHER_FIXTURE_NODE_FAIL: "1" })).rejects.toMatchObject({ code: 29 });
      expect(await app.calls()).toHaveLength(2);
    });
  });
}
