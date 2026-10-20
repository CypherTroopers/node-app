import type { IPty } from "@lydell/node-pty";
import type { WindowsHostCommand, WindowsHostEvent } from "./windows-process.js";

const outputLimit = 32 * 1024;
let terminal: IPty | undefined;
let launched = false;
let exited = false;
let exitCode = 0;
let exitSent = false;
let retiring = false;
let output = "";
let sending = false;

function send(event: WindowsHostEvent, complete?: () => void): void {
  if (!process.connected || !process.send) {
    complete?.();
    return;
  }
  try {
    process.send(event, () => complete?.());
  } catch {
    complete?.();
  }
}

function flush(): void {
  if (sending || !terminal || !process.connected) return;
  if (output) {
    const data = output;
    output = "";
    sending = true;
    send({ type: "data", data, pid: terminal.pid }, () => {
      sending = false;
      flush();
    });
  } else if (exited && !exitSent) {
    exitSent = true;
    send({ type: "exit", exitCode, pid: terminal.pid });
  }
}

function isLaunch(value: unknown): value is Extract<WindowsHostCommand, { type: "launch" }> {
  return Boolean(
    value &&
    typeof value === "object" &&
    "type" in value &&
    value.type === "launch" &&
    "script" in value &&
    typeof value.script === "string" &&
    "rootDir" in value &&
    typeof value.rootDir === "string" &&
    "env" in value &&
    value.env &&
    typeof value.env === "object" &&
    !Array.isArray(value.env) &&
    Object.values(value.env).every((entry) => typeof entry === "string"),
  );
}

async function start(): Promise<void> {
  const { spawn } = await import("@lydell/node-pty");
  process.on("message", (value: unknown) => {
    if (isLaunch(value) && !launched && !retiring) {
      launched = true;
      try {
        terminal = spawn(
          "powershell.exe",
          ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", value.script],
          {
            cwd: value.rootDir,
            env: value.env,
            name: "xterm-256color",
            useConpty: true,
            cols: 120,
            rows: 30,
          },
        );
        terminal.onData((data) => {
          output = (output + data).slice(-outputLimit);
          flush();
        });
        terminal.onExit((event) => {
          exited = true;
          exitCode = event.exitCode;
          flush();
        });
      } catch {
        // Spawn can have partially constructed a native console. Retain this host;
        // only the manager may decide whether the native operation has settled.
        send({ type: "error" });
      }
      return;
    }
    if (!value || typeof value !== "object" || !("type" in value)) {
      send({ type: "error" });
      return;
    }
    if (value.type === "interrupt" && terminal && !exited && !retiring) {
      try {
        terminal.write("\x03");
      } catch {
        send({ type: "error" });
      }
    } else if (value.type === "retire" && exited && !retiring) {
      retiring = true;
      // The manager has confirmed IPC absence in addition to this genuine PTY
      // exit. Terminate only this owned host, releasing its leaked worker handles
      // without calling the dependency's cached-PID kill path.
      if (process.send && process.connected)
        process.send({ type: "retired" } satisfies WindowsHostEvent, () => process.exit(0));
      else process.exit(0);
    } else {
      send({ type: "error" });
    }
  });
  send({ type: "ready" });
}

void start().catch(() => {
  send({ type: "error" }, () => {
    process.exitCode = 1;
    if (process.connected && process.disconnect) process.disconnect();
  });
});
