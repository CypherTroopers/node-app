import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("./app.js", () => ({ createCypherApp: mocks.create }));

describe.skipIf(process.platform !== "linux")("Linux launcher state discovery", () => {
  const signals = ["SIGINT", "SIGTERM"] as const;
  let directory: string;
  let canonicalDir: string;
  let legacyDir: string;
  let originalArguments: string[];
  let originalListeners: Map<(typeof signals)[number], Set<() => void>>;

  beforeEach(async () => {
    vi.resetModules();
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "colossusx-state-test-"));
    const dataRoot = path.join(directory, "data");
    const configRoot = path.join(directory, "config");
    canonicalDir = path.join(dataRoot, "colossusx-node-manager", "runtime");
    legacyDir = path.join(configRoot, "ColossusX Node Manager", "runtime");
    vi.stubEnv("XDG_DATA_HOME", dataRoot);
    vi.stubEnv("XDG_CONFIG_HOME", configRoot);
    originalArguments = process.argv;
    process.argv = [process.execPath, "cypher-node-manager"];
    originalListeners = new Map(
      signals.map((signal) => [signal, new Set(process.listeners(signal))]),
    );
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.create.mockReset().mockReturnValue({
      listen: vi.fn().mockResolvedValue({ bootstrapUrl: "http://127.0.0.1:1/#token=synthetic" }),
      close: vi.fn().mockResolvedValue(undefined),
    });
  });

  afterEach(async () => {
    process.argv = originalArguments;
    for (const signal of signals) {
      for (const listener of process.listeners(signal)) {
        if (!originalListeners.get(signal)?.has(listener)) process.off(signal, listener);
      }
    }
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it.each([
    { name: "fresh installation", canonical: false, legacy: false },
    { name: "existing CLI data", canonical: true, legacy: false },
    { name: "existing desktop data", canonical: false, legacy: true },
    { name: "both existing directories", canonical: true, legacy: true },
  ])(
    "selects shared state for $name without moving existing files",
    async ({ canonical, legacy }) => {
      const sentinels = new Map<string, string>();
      for (const [stateDir, present] of [
        [canonicalDir, canonical],
        [legacyDir, legacy],
      ] as const) {
        if (!present) continue;
        const keystore = path.join(stateDir, "cypher", "chaindbname", "keystore");
        await fs.mkdir(keystore, { recursive: true });
        const sentinel = path.join(keystore, "synthetic-wallet");
        const contents = `existing synthetic data at ${stateDir}`;
        await fs.writeFile(sentinel, contents);
        sentinels.set(sentinel, contents);
      }

      await import("./cli.js");

      expect(mocks.create).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ stateDir: !canonical && legacy ? legacyDir : canonicalDir }),
      );
      if (canonical && legacy) {
        expect(console.warn).toHaveBeenCalledOnce();
        const warning = vi.mocked(console.warn).mock.calls[0]?.[0];
        expect(warning).toContain(canonicalDir);
        expect(warning).toContain(legacyDir);
        expect(warning).toContain("left unchanged");
        expect(warning).toContain("--state-dir");
      } else {
        expect(console.warn).not.toHaveBeenCalled();
      }
      for (const [sentinel, contents] of sentinels) {
        expect(await fs.readFile(sentinel, "utf8")).toBe(contents);
      }
      for (const [stateDir, present] of [
        [canonicalDir, canonical],
        [legacyDir, legacy],
      ] as const) {
        if (!present) await expect(fs.stat(stateDir)).rejects.toMatchObject({ code: "ENOENT" });
      }
    },
  );

  it("uses an explicit state directory without inspecting unusable defaults", async () => {
    await fs.writeFile(path.join(directory, "data"), "not a directory");
    await fs.writeFile(path.join(directory, "config"), "not a directory");
    const explicitDir = path.join(directory, "operator-selected runtime");
    process.argv.push("--state-dir", explicitDir);

    await import("./cli.js");

    expect(mocks.create).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ stateDir: explicitDir }),
    );
    expect(console.warn).not.toHaveBeenCalled();
  });
});
