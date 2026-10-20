import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchCypherProcess, type CypherProcess } from "../src/cypher/process.js";

const marker = "cypher-desktop-runtime";
const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 2 && args[0] === "--windows-host"));
const windowsHostPath = args[1];

async function verifyWindowsProcess(): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cypher-desktop-runtime-"));
  const script = path.join(directory, "runtime.ps1");
  await fs.writeFile(script, `[Console]::Out.WriteLine('${marker}')\r\nexit 0\r\n`, {
    flag: "wx",
  });
  let handle: CypherProcess | undefined;
  let exited = false;
  let released = false;
  try {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    console.log(JSON.stringify({ phase: "production-adapter-launch" }));
    const node = await launchCypherProcess({
      platform: process.platform,
      script,
      rootDir: directory,
      env,
      assertCurrent: () => {},
      ...(windowsHostPath ? { windowsHostPath } : {}),
    });
    handle = node;
    assert.ok(node.release, "The Windows process adapter must release its retired helper.");
    let output = "";
    let observedPid = 0;
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      node.onError?.((message) => reject(new Error(message)));
      node.onData((data) => {
        output += data;
        if (output.includes(marker)) {
          observedPid = node.pid;
          console.log(JSON.stringify({ phase: "production-adapter-marker", pid: observedPid }));
        }
      });
      node.onExit((code) => {
        exited = true;
        console.log(
          JSON.stringify({
            phase: "production-adapter-exit",
            exitCode: code,
            markerSeen: output.includes(marker),
          }),
        );
        resolve(code);
      });
    });
    assert.equal(exitCode, 0);
    assert.equal(output.includes(marker), true);
    assert.ok(
      Number.isInteger(observedPid) && observedPid > 0,
      "Expected a live PTY PID at marker delivery",
    );
    await node.release();
    released = true;
    console.log(JSON.stringify({ phase: "production-adapter-released" }));
  } finally {
    // Release is authorized only after the actual shell exit; it joins the owned helper.
    if (handle && exited && !released) {
      await handle.release?.();
      released = true;
    }
    if (!handle || released) await fs.rm(directory, { recursive: true, force: true });
  }
}

const database = new DatabaseSync(":memory:");
try {
  assert.equal(database.prepare("select 1 as value").get()?.value, 1);
} finally {
  database.close();
}
assert.equal(process.versions.electron, "44.9.1");
if (process.platform === "win32") await verifyWindowsProcess();
console.log(
  JSON.stringify({
    phase: "desktop-runtime-verified",
    electron: process.versions.electron,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
  }),
);
