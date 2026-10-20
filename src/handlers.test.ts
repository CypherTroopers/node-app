import { afterEach, describe, expect, it, vi } from "vitest";
import { CypherOperations } from "./handlers.js";
import { CypherAppService } from "./service.js";

const services: CypherAppService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.stop()));
  vi.restoreAllMocks();
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
