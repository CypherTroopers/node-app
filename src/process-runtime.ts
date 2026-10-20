import { spawn } from "node:child_process";
import path from "node:path";
import { resolveEnvironmentValue } from "./environment.js";

export type BufferedProcessOptions = {
  args?: string[];
  signal: AbortSignal;
  assertCurrent(): void;
  timeoutMs: number;
  maxOutputBytes: { stdout: number; stderr: number };
  env: NodeJS.ProcessEnv;
};
export type BufferedProcessResult = {
  stdout: Buffer;
  stderr: Buffer;
  code: number | null;
  signal: NodeJS.Signals | null;
  termination: "exit" | "timeout" | "aborted" | "output-limit" | "spawn-error";
};

/** Runs a verified generator without a shell; cancellation retains ownership through process close. */
export async function runBufferedProcess(
  executable: string,
  options: BufferedProcessOptions,
): Promise<BufferedProcessResult> {
  options.signal.throwIfAborted();
  options.assertCurrent();
  const child = spawn(executable, options.args ?? [], {
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  let termination: BufferedProcessResult["termination"] = "exit";
  let closed = false;
  let cleanup: Promise<void> | undefined;
  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  const chunks: Record<"stdout" | "stderr", Buffer[]> = { stdout: [], stderr: [] };
  const lengths = { stdout: 0, stderr: 0 };

  const signalGroup = (signal: "SIGTERM" | "SIGKILL") => {
    if (!child.pid) return;
    try {
      // This child was created as the process-group leader; never target an unrelated positive PID.
      process.kill(-child.pid, signal);
    } catch (error) {
      if (
        !(typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH")
      ) {
        throw error;
      }
    }
  };
  const terminate = (reason: BufferedProcessResult["termination"]) => {
    if (termination !== "exit" || closed) return;
    termination = reason;
    if (!child.pid) return;
    if (process.platform === "win32") {
      // Close can wait on inherited pipes after the leader exits. Its old PID
      // no longer authorizes taskkill, which might target a recycled process.
      if (child.exitCode !== null || child.signalCode !== null) return;
      // Only the app's directly owned child can authorize tree termination.
      // Keep taskkill settlement owned even if the generator closes first.
      cleanup = new Promise<void>((resolve) => {
        const systemRoot = resolveEnvironmentValue(process.env, "SystemRoot") ?? "C:\\Windows";
        const killer = spawn(
          path.win32.join(systemRoot, "System32", "taskkill.exe"),
          ["/F", "/T", "/PID", String(child.pid)],
          { stdio: "ignore", windowsHide: true, env: { SystemRoot: systemRoot } },
        );
        killer.once("error", () => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        });
        killer.once("close", () => resolve());
      });
    } else {
      try {
        signalGroup("SIGTERM");
      } catch {
        /* Retain ownership until close if the OS rejects the group signal. */
      }
      forceTimer = setTimeout(() => {
        try {
          signalGroup("SIGKILL");
        } catch {
          /* Never fall back to a potentially reused positive PID. */
        }
      }, 1000);
      forceTimer.unref();
    }
  };
  const onAbort = () => terminate("aborted");
  const timeout = setTimeout(() => terminate("timeout"), options.timeoutMs);
  timeout.unref();
  options.signal.addEventListener("abort", onAbort, { once: true });
  if (options.signal.aborted) onAbort();
  for (const stream of ["stdout", "stderr"] as const) {
    child[stream].on("data", (data: Buffer) => {
      const remaining = options.maxOutputBytes[stream] - lengths[stream];
      if (data.length > remaining) {
        terminate("output-limit");
      }
      if (remaining > 0) {
        const kept = Buffer.from(data.subarray(0, remaining));
        chunks[stream].push(kept);
        lengths[stream] += kept.length;
      }
      data.fill(0);
    });
  }
  child.once("error", () => {
    termination = "spawn-error";
  });
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.once("close", (code, signal) => {
        closed = true;
        resolve({ code, signal });
      });
    },
  );
  clearTimeout(timeout);
  options.signal.removeEventListener("abort", onAbort);
  // A descendant may retain the pipes after its leader exits; close is the cleanup boundary.
  if (forceTimer) clearTimeout(forceTimer);
  try {
    await cleanup;
    const stdout = Buffer.concat(chunks.stdout, lengths.stdout);
    const stderr = Buffer.concat(chunks.stderr, lengths.stderr);
    return { ...result, stdout, stderr, termination };
  } finally {
    for (const buffer of [...chunks.stdout, ...chunks.stderr]) buffer.fill(0);
  }
}
