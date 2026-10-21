import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type StateDirectory = { stateDir: string; warning?: string };

async function exists(directory: string): Promise<boolean> {
  try {
    await fs.access(directory);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

/** Both launchers share existing data in place; upgrades never move or merge it. */
export async function resolveStateDirectory(explicitPath?: string): Promise<StateDirectory> {
  if (explicitPath !== undefined) return { stateDir: path.resolve(explicitPath) };

  const homeDirectory = os.homedir();
  if (process.platform === "win32") {
    return {
      stateDir: path.join(
        process.env.APPDATA ?? path.join(homeDirectory, "AppData", "Roaming"),
        "ColossusX Node Manager",
        "runtime",
      ),
    };
  }
  if (process.platform === "darwin") {
    return {
      stateDir: path.join(
        homeDirectory,
        "Library",
        "Application Support",
        "ColossusX Node Manager",
        "runtime",
      ),
    };
  }

  const stateDir = path.join(
    process.env.XDG_DATA_HOME ?? path.join(homeDirectory, ".local", "share"),
    "colossusx-node-manager",
    "runtime",
  );
  const legacyDir = path.join(
    process.env.XDG_CONFIG_HOME ?? path.join(homeDirectory, ".config"),
    "ColossusX Node Manager",
    "runtime",
  );
  const [canonicalExists, legacyExists] = await Promise.all([exists(stateDir), exists(legacyDir)]);
  if (!canonicalExists && legacyExists) return { stateDir: legacyDir };
  return {
    stateDir,
    ...(canonicalExists && legacyExists
      ? {
          warning: `Using ${stateDir}. Existing desktop data at ${legacyDir} was left unchanged. Close this app and use the CLI's --state-dir option to select that directory explicitly.`,
        }
      : {}),
  };
}
