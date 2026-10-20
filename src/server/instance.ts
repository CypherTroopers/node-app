import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/** An OS-held SQLite lock survives no crash and cannot be stolen by PID reuse. */
export async function acquireInstance(stateDir: string): Promise<() => void> {
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(path.join(stateDir, "instance.sqlite"));
  try {
    // Startup/shutdown lock primitive only; application data stays in its worker.
    database.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;");
  } catch {
    database.close();
    throw new Error(
      "This data directory is already open in another ColossusX app. Close it first.",
    );
  }
  return () => database.close();
}
