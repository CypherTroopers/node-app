import { describe, expect, it, vi } from "vitest";
import { createRequestAuthority } from "./authority.js";

describe("Cypher app request authority", () => {
  it.each(["session", "service"] as const)(
    "cancels native work when the %s owner closes",
    (source) => {
      const session = new AbortController();
      const service = new AbortController();
      const current = vi.fn();
      const authority = createRequestAuthority(
        { signal: session.signal, assertCurrent: current },
        service.signal,
      );
      authority.assertCurrent();
      expect(current).toHaveBeenCalledOnce();
      (source === "session" ? session : service).abort();
      expect(authority.signal.aborted).toBe(true);
      expect(authority.assertCurrent).toThrow("no longer authorized");
      expect(current).toHaveBeenCalledOnce();
    },
  );

  it("revalidates the session owner's live grant and sanitizes its rejection", () => {
    let current = true;
    const authority = createRequestAuthority(
      {
        assertCurrent() {
          if (!current) throw new Error("fixture-secret-session");
        },
      },
      new AbortController().signal,
    );
    authority.assertCurrent();
    current = false;
    expect(authority.assertCurrent).toThrow("no longer authorized");
    expect(authority.assertCurrent).not.toThrow("fixture-secret-session");
  });
});
