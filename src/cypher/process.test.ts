import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { launchCypherProcess } from "./process.js";
import type { WindowsHostCommand } from "./windows-process.js";

const processes = vi.hoisted(() => ({ fork: vi.fn() }));
// mock-isolation: Exercise host admission and IPC lifetime without a native Windows console.
vi.mock("node:child_process", () => ({ fork: processes.fork, spawn: vi.fn() }));

class Host extends EventEmitter {
  connected = true;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  send = vi.fn((_command: WindowsHostCommand, complete: (error: Error | null) => void) =>
    complete(null),
  );
  kill = vi.fn(() => {
    this.close();
    return true;
  });
  close() {
    this.connected = false;
    this.exitCode = 0;
    this.emit("disconnect");
    this.emit("close", 0, null);
  }
}
const options = {
  platform: "win32",
  rootDir: "C:\\Cypher",
  script: "C:\\Cypher\\launch.ps1",
  windowsHostPath: "C:\\App\\dist\\windows-pty-host.js",
  env: { SystemRoot: "C:\\Windows" },
  assertCurrent() {},
};
let host: Host;
beforeEach(() => {
  vi.useFakeTimers();
  host = new Host();
  processes.fork.mockImplementation(() => {
    queueMicrotask(() => host.emit("message", { type: "ready" }));
    return host;
  });
});
afterEach(() => {
  processes.fork.mockReset();
  vi.useRealTimers();
});

describe("Windows node host ownership", () => {
  it("replays early terminal facts, publishes the live PID, and joins retirement after real terminal exit", async () => {
    host.send.mockImplementation((command, complete) => {
      if (command.type === "launch") {
        host.emit("message", { type: "data", data: "fixture native output", pid: 321 });
        host.emit("message", { type: "exit", exitCode: 0, pid: 321 });
      } else if (command.type === "retire") host.close();
      complete(null);
    });
    const owner = await launchCypherProcess(options);
    const data = vi.fn();
    const exit = vi.fn();
    owner.onData(data);
    owner.onExit(exit);
    expect(data).toHaveBeenCalledWith("fixture native output");
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(owner.pid).toBe(321);
    await owner.release?.();
    expect(host.send.mock.calls.map(([command]) => command.type)).toEqual(["launch", "retire"]);
    expect(host.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("joins the uncommitted helper if authority is revoked while imports become ready", async () => {
    const authority = new AbortController();
    const entered = Promise.withResolvers<void>();
    processes.fork.mockImplementationOnce(() => {
      entered.resolve();
      return host;
    });
    const launching = launchCypherProcess({ ...options, signal: authority.signal });
    // The public launcher lazy-loads its adapter before creating the helper.
    await entered.promise;
    const rejected = expect(launching).rejects.toThrow("no longer authorized");
    authority.abort();
    await rejected;
    expect(host.send).not.toHaveBeenCalled();
    expect(host.kill).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps a launched host owned after transport death and never invents a terminal exit", async () => {
    const owner = await launchCypherProcess(options);
    host.close();
    const error = vi.fn();
    const exit = vi.fn();
    owner.onError?.(error);
    owner.onExit(exit);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("host stopped unexpectedly"));
    expect(exit).not.toHaveBeenCalled();
    await expect(owner.release?.()).rejects.toThrow("exit has not been confirmed");
    expect(host.send.mock.calls.map(([command]) => command.type)).toEqual(["launch"]);
    expect(host.kill).not.toHaveBeenCalled();
  });

  it("adopts transport failure during the launch commit and refuses unconfirmed retirement", async () => {
    host.send.mockImplementationOnce((_command, complete) =>
      complete(new Error("fixture transport failure")),
    );
    const owner = await launchCypherProcess(options);
    const error = vi.fn();
    owner.onError?.(error);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("host stopped unexpectedly"));
    await expect(owner.release?.()).rejects.toThrow("exit has not been confirmed");
    expect(host.kill).not.toHaveBeenCalled();
  });
});
