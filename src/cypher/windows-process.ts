import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CypherOperationError } from "./operations-contract.js";
import type { CypherLaunchOptions, CypherProcess } from "./process.js";

export type WindowsHostCommand =
  | { type: "launch"; script: string; rootDir: string; env: Record<string, string> }
  | { type: "interrupt" }
  | { type: "retire" };
export type WindowsHostEvent =
  | { type: "ready" }
  | { type: "retired" }
  | { type: "data"; data: string; pid: number }
  | { type: "exit"; exitCode: number; pid: number }
  | { type: "error" };

const hostFailure =
  "The Windows terminal host stopped unexpectedly. Keep this app open and check the node before retrying Stop or Close.";
const earlyOutputLimit = 32 * 1024;
const startupTimeoutMs = 30_000;

function isEvent(value: unknown): value is WindowsHostEvent {
  if (!value || typeof value !== "object" || !("type" in value)) return false;
  switch (value.type) {
    case "ready":
    case "retired":
    case "error":
      return true;
    case "data":
      return (
        "data" in value &&
        typeof value.data === "string" &&
        "pid" in value &&
        typeof value.pid === "number" &&
        Number.isInteger(value.pid) &&
        value.pid >= 0
      );
    case "exit":
      return (
        "exitCode" in value &&
        typeof value.exitCode === "number" &&
        Number.isInteger(value.exitCode) &&
        "pid" in value &&
        typeof value.pid === "number" &&
        Number.isInteger(value.pid) &&
        value.pid >= 0
      );
    default:
      return false;
  }
}

/** Contains the dependency's ConPTY workers in an explicitly retired, app-owned process. */
export async function launchWindowsProcess(options: CypherLaunchOptions): Promise<CypherProcess> {
  options.signal?.throwIfAborted();
  options.assertCurrent();
  const helper =
    options.windowsHostPath ??
    fileURLToPath(
      new URL(
        import.meta.url.endsWith(".ts")
          ? "../../dist/windows-pty-host.js"
          : "./windows-pty-host.js",
        import.meta.url,
      ),
    );
  const child = fork(helper, [], {
    execPath: process.execPath,
    execArgv: [],
    env: { ...options.env, ELECTRON_RUN_AS_NODE: "1" },
    cwd: options.rootDir,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    windowsHide: true,
  });
  const readiness = Promise.withResolvers<void>();
  const closure = Promise.withResolvers<void>();
  const dataListeners = new Set<(data: string) => void>();
  const exitListeners = new Set<(code: number | null) => void>();
  const errorListeners = new Set<(message: string) => void>();
  let launched = false;
  let closed = false;
  let retiring = false;
  let exited = false;
  let exitCode: number | null = null;
  let pid = 0;
  let earlyOutput = "";
  let failure: string | undefined;
  let release: Promise<void> | undefined;
  const fail = () => {
    if (failure) return;
    failure = hostFailure;
    readiness.reject(new CypherOperationError(failure));
    for (const listener of errorListeners) listener(failure);
  };
  child.on("message", (value: unknown) => {
    if (!isEvent(value)) {
      fail();
      return;
    }
    switch (value.type) {
      case "ready":
        readiness.resolve();
        break;
      case "retired":
        if (!retiring) fail();
        break;
      case "error":
        fail();
        break;
      case "data":
        if (!launched || exited) {
          fail();
          return;
        }
        pid = value.pid || pid;
        if (dataListeners.size) for (const listener of dataListeners) listener(value.data);
        else earlyOutput = (earlyOutput + value.data).slice(-earlyOutputLimit);
        break;
      case "exit":
        if (!launched || exited) {
          fail();
          return;
        }
        exited = true;
        exitCode = value.exitCode;
        pid = value.pid || pid;
        for (const listener of exitListeners) listener(exitCode);
        break;
    }
  });
  child.once("error", fail);
  child.once("disconnect", () => {
    if (!retiring) fail();
  });
  child.once("close", () => {
    closed = true;
    if (!retiring) fail();
    closure.resolve();
  });
  const send = (command: WindowsHostCommand) => {
    if (!child.connected) {
      fail();
      return;
    }
    try {
      child.send(command, (error) => {
        if (error) fail();
      });
    } catch {
      fail();
    }
  };
  const timer = setTimeout(
    () =>
      readiness.reject(
        new CypherOperationError(
          "The Windows terminal host could not initialize. Check the app installation and try again.",
        ),
      ),
    startupTimeoutMs,
  );
  timer.unref();
  const abort = () =>
    readiness.reject(new CypherOperationError("The Cypher operation is no longer authorized."));
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    if (options.signal?.aborted) abort();
    await readiness.promise;
    options.signal?.throwIfAborted();
    options.assertCurrent();
    if (failure || closed) throw new CypherOperationError(hostFailure);
  } catch (error) {
    // No launch command has been admitted: this helper cannot own a Cypher node.
    retiring = true;
    if (!closed && child.exitCode === null && child.signalCode === null) child.kill();
    await closure.promise;
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }

  const handle: CypherProcess = {
    get pid() {
      return pid;
    },
    onData(listener) {
      dataListeners.add(listener);
      if (earlyOutput) {
        const data = earlyOutput;
        earlyOutput = "";
        listener(data);
      }
    },
    onExit(listener) {
      exitListeners.add(listener);
      if (exited) listener(exitCode);
    },
    onError(listener) {
      errorListeners.add(listener);
      if (failure) listener(failure);
    },
    interrupt() {
      if (exited || closed || failure) throw new CypherOperationError(hostFailure);
      send({ type: "interrupt" });
      if (failure) throw new CypherOperationError(failure);
    },
    release() {
      if (!exited)
        return Promise.reject(
          new CypherOperationError(
            "The Windows terminal exit has not been confirmed. Its host has been retained.",
          ),
        );
      if (release) return release;
      retiring = true;
      if (!closed) send({ type: "retire" });
      release = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () =>
            reject(
              new CypherOperationError(
                "The Windows terminal host did not finish retiring. Its owner has been retained; retry Stop or Close.",
              ),
            ),
          startupTimeoutMs,
        );
        timeout.unref();
        void closure.promise.then(() => {
          clearTimeout(timeout);
          resolve();
        });
      }).catch((error: unknown) => {
        release = undefined;
        throw error;
      });
      return release;
    },
  };
  // This synchronous dispatch commits launch ownership. A later transport failure
  // belongs to the returned handle, never an exception that abandons the process.
  launched = true;
  send({ type: "launch", script: options.script, rootDir: options.rootDir, env: options.env });
  return handle;
}
