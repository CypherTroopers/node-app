import { afterEach, describe, expect, it, vi } from "vitest";
import { CypherAppService } from "./service.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Cypher app resource lifetime", () => {
  it("revokes service authority before joining native preparation, node, and wallet owners", async () => {
    const service = new CypherAppService("/fixture/app");
    expect(() => service.current()).toThrow("unavailable");
    service.start("/fixture/state");
    const owners = service.current();
    const walletClosed = Promise.withResolvers<void>();
    const nodeClosed = Promise.withResolvers<void>();
    const installerClosed = Promise.withResolvers<void>();
    const installer = vi.spyOn(owners.installer, "close").mockReturnValue(installerClosed.promise);
    const wallet = vi.spyOn(owners.wallet, "close").mockReturnValue(walletClosed.promise);
    const node = vi.spyOn(owners.node, "close").mockReturnValue(nodeClosed.promise);
    let completed = false;
    const stopped = service.stop().then(() => {
      completed = true;
    });
    expect(owners.signal.aborted).toBe(true);
    expect(() => service.current()).toThrow("unavailable");
    expect(wallet).toHaveBeenCalledOnce();
    expect(node).toHaveBeenCalledOnce();
    expect(installer).toHaveBeenCalledOnce();
    walletClosed.resolve();
    await walletClosed.promise;
    expect(completed).toBe(false);
    nodeClosed.resolve();
    await nodeClosed.promise;
    expect(completed).toBe(false);
    installerClosed.resolve();
    await stopped;
    service.start("/fixture/state");
    expect(service.current().signal.aborted).toBe(false);
    expect(service.current()).not.toBe(owners);
    await service.stop();
  });

  it("prevents a second owner after an unconfirmed native shutdown", async () => {
    const service = new CypherAppService("/fixture/app");
    service.start("/fixture/state");
    const owners = service.current();
    vi.spyOn(owners.node, "close").mockRejectedValue(new Error("fixture native failure"));
    const wallet = vi.spyOn(owners.wallet, "close");
    await expect(service.stop()).rejects.toThrow("Check the node");
    expect(wallet).toHaveBeenCalledOnce();
    expect(() => service.start("/fixture/state")).toThrow("shutting down");
  });
  it("retains failed teardown owners for a later Close retry and admits no work between attempts", async () => {
    const service = new CypherAppService("/fixture/app");
    service.start("/fixture/state");
    const owners = service.current();
    const node = vi
      .spyOn(owners.node, "close")
      .mockRejectedValueOnce(new Error("fixture process still running"))
      .mockResolvedValueOnce();
    await expect(service.stop()).rejects.toThrow("Check the node");
    expect(owners.signal.aborted).toBe(true);
    expect(() => service.current()).toThrow("unavailable");
    expect(() => service.start("/fixture/state")).toThrow("shutting down");
    await service.stop();
    expect(node).toHaveBeenCalledTimes(2);
    service.start("/fixture/state");
    expect(service.current()).not.toBe(owners);
    await service.stop();
  });
});
