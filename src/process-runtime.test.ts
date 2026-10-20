import { watch } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runBufferedProcess, type BufferedProcessOptions } from "./process-runtime.js";

const options = (signal = new AbortController().signal): BufferedProcessOptions => ({
  signal,
  assertCurrent() {},
  timeoutMs: 25_000,
  maxOutputBytes: { stdout: 4096, stderr: 4096 },
  env: {},
});
afterEach(() => vi.unstubAllEnvs());

describe("standalone buffered process execution", () => {
  it("executes directly with only the supplied environment and captures byte output", async () => {
    vi.stubEnv("CYPHER_FIXTURE_OPERATOR_SECRET", "must-not-be-inherited");
    const result = await runBufferedProcess(process.execPath, {
      ...options(),
      env: { CYPHER_FIXTURE_VALUE: "fixture-value" },
      args: [
        "-e",
        "process.stdout.write(String(process.env.CYPHER_FIXTURE_VALUE));process.stderr.write(String(process.env.CYPHER_FIXTURE_OPERATOR_SECRET));",
      ],
    });
    expect(result).toMatchObject({ code: 0, termination: "exit" });
    expect(result.stdout.toString()).toBe("fixture-value");
    expect(result.stderr.toString()).toBe("undefined");
  });

  it("terminates oversized output while retaining only each stream's byte limit", async () => {
    const result = await runBufferedProcess(process.execPath, {
      ...options(),
      args: [
        "-e",
        "process.stdout.write(Buffer.alloc(65536,65));process.stderr.write(Buffer.alloc(65536,66));",
      ],
    });
    expect(result.termination).toBe("output-limit");
    expect(result.stdout.length).toBeLessThanOrEqual(4096);
    expect(result.stderr.length).toBeLessThanOrEqual(4096);
    expect(result.stdout.equals(Buffer.alloc(result.stdout.length, 65))).toBe(true);
    expect(result.stderr.equals(Buffer.alloc(result.stderr.length, 66))).toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "joins the owned Unix group and inherited pipes after cancellation",
    async () => {
      // Standalone project owns this raw subprocess fixture and all its temporary files.
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cypher-app-process-"));
      const ready = path.join(directory, "ready");
      const receipt = path.join(directory, "terminated");
      const readiness = Promise.withResolvers<void>();
      const watcher = watch(directory, (_event, filename) => {
        if (filename === "ready") readiness.resolve();
      });
      watcher.on("error", readiness.reject);
      const abort = new AbortController();
      // Real child timers only keep the isolated process fixture alive; tests synchronize through fs events.
      const grandchild = `const fs=require('node:fs');process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(receipt)},'terminated');process.exit(0)});fs.writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},100000);`;
      const child = `const {spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:['ignore','inherit','inherit']});process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},100000);`;
      const result = runBufferedProcess(process.execPath, {
        ...options(abort.signal),
        args: ["-e", child],
      });
      try {
        await readiness.promise;
        abort.abort();
        await expect(result).resolves.toMatchObject({ termination: "aborted" });
        expect(await fs.readFile(receipt, "utf8")).toBe("terminated");
      } finally {
        abort.abort();
        await result;
        watcher.close();
        await fs.rm(directory, { recursive: true, force: true });
      }
    },
  );
});
