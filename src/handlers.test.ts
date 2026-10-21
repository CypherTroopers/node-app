import { afterEach, describe, expect, it, vi } from "vitest";
import { CypherOperations } from "./handlers.js";
import { CypherAppService } from "./service.js";

const services: CypherAppService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.stop()));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function fixture() {
  const service = new CypherAppService("/fixture/app");
  service.start("/fixture/state");
  services.push(service);
  const operations = new CypherOperations(service);
  const session = new AbortController();
  const authority = {
    signal: session.signal,
    assertCurrent() {
      session.signal.throwIfAborted();
    },
  };
  const invoke = (method: string, params: unknown = {}) =>
    operations.request(method, params, authority);
  return { service, operations, invoke, session };
}

describe("Cypher app public operation boundary", () => {
  it("keeps setup inspection read-only and refuses a retired session before native preparation", async () => {
    const { service, invoke, session } = fixture();
    const installer = service.current().installer;
    const current = await installer.status();
    const prepare = vi.spyOn(installer, "prepare").mockResolvedValue(current);
    await expect(invoke("cypher.setup.status")).resolves.toEqual(current);
    expect(prepare).not.toHaveBeenCalled();
    session.abort();
    await expect(invoke("cypher.setup.prepare")).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(prepare).not.toHaveBeenCalled();
  });

  it("requires current managed launch files before starting, independently of the wallet or an external root", async () => {
    const { service, invoke } = fixture();
    const owners = service.current();
    const stopped = await owners.node.status();
    const start = vi.spyOn(owners.node, "start").mockResolvedValue(stopped);
    await expect(invoke("cypher.start")).rejects.toMatchObject({
      code: "UNAVAILABLE",
      message: expect.stringContaining("Prepare node"),
    });
    expect(start).not.toHaveBeenCalled();

    const setup = await owners.installer.status();
    expect(setup.node.ready).toBe(false);
    vi.spyOn(owners.installer, "status").mockResolvedValue({
      ...setup,
      node: { ...setup.node, ready: true },
      wallet: { ...setup.wallet, ready: false },
    });
    await expect(invoke("cypher.start")).resolves.toEqual(stopped);
    expect(start).toHaveBeenCalledOnce();

    vi.stubEnv("CYPHER_ROOT", "/operator-managed-native");
    const external = fixture();
    const externalOwners = external.service.current();
    const externalStatus = await externalOwners.node.status();
    expect((await externalOwners.installer.status()).node.ready).toBe(false);
    expect(externalStatus.rootDir).not.toBe(externalOwners.installer.nodeRoot);
    const externalStart = vi.spyOn(externalOwners.node, "start").mockResolvedValue(externalStatus);
    await expect(external.invoke("cypher.start")).resolves.toEqual(externalStatus);
    expect(externalStart).toHaveBeenCalledOnce();
  });

  it.each([
    [
      "cypher.transfers.prepare",
      { from: `0x${"1".repeat(40)}`, to: `0x${"2".repeat(40)}`, amount: 0.1 },
    ],
    [
      "cypher.transfers.prepare",
      { from: `0x${"1".repeat(40)}`, to: `0x${"2".repeat(40)}`, amount: "0.0000000000000000001" },
    ],
    [
      "cypher.transfers.send",
      { requestId: "invalid", quoteId: "invalid", password: "fixture-secret" },
    ],
    ["cypher.wallets.list", { limit: 51 }],
    ["cypher.start", { shellCommand: "fixture-secret" }],
    ["cypher.setup.status", null],
  ] as const)(
    "rejects invalid %s input without reflecting sensitive parameters",
    async (method, params) => {
      const { invoke } = fixture();
      const failure: unknown = await invoke(method, params).catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: "INVALID_REQUEST" });
      expect(JSON.stringify(failure)).not.toContain("fixture-secret");
    },
  );

  it("returns only registered operations and does not reflect unknown operation names", async () => {
    const { invoke } = fixture();
    const failure: unknown = await invoke("fixture-secret-command").catch(
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ code: "METHOD_NOT_FOUND" });
    expect(JSON.stringify(failure)).not.toContain("fixture-secret");
  });

  it("rechecks authority after a queued mutation becomes eligible", async () => {
    const { service, invoke, session } = fixture();
    const owners = service.current();
    const blocked = Promise.withResolvers<void>();
    const began = Promise.withResolvers<void>();
    const disconnect = vi.spyOn(owners.node, "disconnect");
    const first = service.mutate(owners, { assertCurrent() {} }, async () => {
      began.resolve();
      await blocked.promise;
    });
    await began.promise;
    const queued = invoke("cypher.disconnect");
    const rejected = expect(queued).rejects.toMatchObject({ code: "FORBIDDEN" });
    session.abort();
    blocked.resolve();
    await first;
    await rejected;
    expect(disconnect).not.toHaveBeenCalled();
  });

  it("sanitizes unexpected owner errors", async () => {
    const { service, invoke } = fixture();
    vi.spyOn(service.current().installer, "status").mockRejectedValue(
      new Error("fixture-private-path-or-secret"),
    );
    const failure: unknown = await invoke("cypher.setup.status").catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "UNAVAILABLE" });
    expect(JSON.stringify(failure)).not.toContain("fixture-private");
  });
});
