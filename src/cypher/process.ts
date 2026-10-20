import { spawn } from "node:child_process";
import { CypherOperationError } from "./operations-contract.js";

export type CypherProcess = {
  pid: number;
  onData(listener: (data: string) => void): void;
  onExit(listener: (code: number | null) => void): void;
  interrupt(): void;
  release?(): Promise<void>;
  onError?(listener: (message: string) => void): void;
};
export type CypherLaunchOptions = {
  platform: string;
  script: string;
  rootDir: string;
  env: Record<string, string>;
  assertCurrent: () => void;
  windowsHostPath?: string;
  signal?: AbortSignal;
};
export async function launchCypherProcess(options: CypherLaunchOptions): Promise<CypherProcess> {
  if (options.platform === "win32") {
    // A Windows pipe child cannot receive a graceful SIGINT via child.kill().
    // ConPTY delivers Ctrl+C to the console running the supplied PowerShell script.
    const { launchWindowsProcess } = await import("./windows-process.js");
    return launchWindowsProcess(options);
  }
  options.assertCurrent();
  const child = spawn("bash", [options.script], {
    cwd: options.rootDir,
    env: options.env,
    detached: true,
    // Keep stdin open: the launchers' default console closes the node on EOF.
    stdio: ["pipe", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", () =>
      reject(new CypherOperationError("The Cypher launch script could not be started.")),
    );
  });
  return {
    pid: child.pid!,
    onData: (listener) => {
      child.stdout.setEncoding("utf8").on("data", listener);
      child.stderr.setEncoding("utf8").on("data", listener);
    },
    onExit: (listener) => {
      child.once("close", (code) => listener(code));
    },
    interrupt: () => {
      // The initialization binary runs before Bash execs the long-lived node.
      process.kill(-child.pid!, "SIGINT");
    },
  };
}
