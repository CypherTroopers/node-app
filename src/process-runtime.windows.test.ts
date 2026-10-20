import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runBufferedProcess } from "./process-runtime.js";

const processIo = vi.hoisted(() => ({ spawn: vi.fn() }));
// mock-isolation: Model the Windows process/pipe lifecycle without taskkill or foreign processes.
vi.mock("node:child_process", () => ({ spawn: processIo.spawn }));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  processIo.spawn.mockReset();
});

describe("Windows buffered process cleanup", () => {
  it("never targets the leader's recycled PID while inherited pipes delay close", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("process", { ...process, platform: "win32" });
    const child = Object.assign(new EventEmitter(), {
      pid: 123,
      exitCode: null as number | null,
      signalCode: null,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
    });
    processIo.spawn.mockReturnValueOnce(child);
    const abort = new AbortController();
    const result = runBufferedProcess("C:\\fixture\\generator.exe", {
      signal: abort.signal,
      assertCurrent() {},
      timeoutMs: 25_000,
      maxOutputBytes: { stdout: 4096, stderr: 4096 },
      env: {},
    });
    child.exitCode = 0;
    child.emit("exit", 0, null);
    abort.abort();
    expect(processIo.spawn).toHaveBeenCalledOnce();
    expect(child.kill).not.toHaveBeenCalled();
    child.emit("close", 0, null);
    await expect(result).resolves.toMatchObject({ termination: "aborted", code: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });
});
