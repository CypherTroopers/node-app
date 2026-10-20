import { afterEach, describe, expect, it, vi } from "vitest";
import { launchCypherProcess } from "./process.js";

const pty = vi.hoisted(() => ({ spawn: vi.fn() }));
// mock-isolation: Verify the Windows ConPTY contract on Linux without opening a native terminal.
vi.mock("@lydell/node-pty", () => ({ spawn: pty.spawn }));
afterEach(() => vi.resetAllMocks());

describe("Windows node process adapter", () => {
  it("delivers graceful Ctrl+C to the owned ConPTY and translates terminal exit", async () => {
    const write = vi.fn();
    const onData = vi.fn();
    const onExit = vi.fn();
    pty.spawn.mockReturnValue({ pid: 123, write, onData, onExit });
    const process = await launchCypherProcess({
      platform: "win32",
      rootDir: "C:\\Cypher",
      script: "C:\\Cypher\\launch.ps1",
      env: { SystemRoot: "C:\\Windows" },
      assertCurrent() {},
    });
    expect(pty.spawn).toHaveBeenCalledWith(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "C:\\Cypher\\launch.ps1"],
      expect.objectContaining({ env: { SystemRoot: "C:\\Windows" }, useConpty: true }),
    );
    const exit = vi.fn();
    process.onExit(exit);
    onExit.mock.calls[0]![0]({ exitCode: 7 });
    expect(exit).toHaveBeenCalledWith(7);
    process.interrupt();
    expect(write).toHaveBeenCalledExactlyOnceWith("\x03");
  });

  it("rechecks live authority after loading the native module and before spawning", async () => {
    let current = true;
    const result = launchCypherProcess({
      platform: "win32",
      rootDir: "C:\\Cypher",
      script: "C:\\Cypher\\launch.ps1",
      env: {},
      assertCurrent() {
        if (!current) throw new Error("fixture retired session");
      },
    });
    current = false;
    await expect(result).rejects.toThrow("retired session");
    expect(pty.spawn).not.toHaveBeenCalled();
  });
});
