#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCypherApp } from "./app.js";

function argumentsForCli() {
  const args = process.argv.slice(2);
  let stateDir =
    process.platform === "win32"
      ? path.join(
          process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"),
          "ColossusX Node Manager",
          "runtime",
        )
      : process.platform === "darwin"
        ? path.join(
            os.homedir(),
            "Library",
            "Application Support",
            "ColossusX Node Manager",
            "runtime",
          )
        : path.join(
            process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"),
            "colossusx-node-manager",
            "runtime",
          );
  let port = 48765;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--help") {
      console.log(
        "Usage: cypher-node-manager [--state-dir PATH] [--port 0..65535]\nThe local launch address grants access to this app. Keep it private.",
      );
      return undefined;
    }
    const value = args[index + 1];
    if (args[index] === "--state-dir" && value) stateDir = path.resolve(value);
    else if (args[index] === "--port" && value && /^\d+$/.test(value)) port = Number(value);
    else throw new Error("Use --help to see supported arguments.");
    index += 1;
  }
  return { stateDir, port };
}

const args = argumentsForCli();
if (args) {
  const local = createCypherApp({
    packageRoot: fileURLToPath(new URL("../", import.meta.url)),
    stateDir: args.stateDir,
  });
  const shutdown = () => {
    void local
      .close()
      .then(() => {
        process.exitCode = 0;
      })
      .catch(() => {
        console.error("The node has not finished stopping. Keep this app open and try again.");
        process.exitCode = 1;
      });
  };
  process.on("SIGINT", shutdown).on("SIGTERM", shutdown);
  try {
    const address = await local.listen(args.port);
    console.log(`Open ColossusX Node Manager: ${address.bootstrapUrl}`);
  } catch {
    console.error(
      "The local app could not start. Check that its data directory and port are available, and use a supported OS/CPU.",
    );
    process.exitCode = 1;
  }
}
