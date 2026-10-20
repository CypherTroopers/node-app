import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpApplicationHost } from "./application-host.ts";
import { CypherApplication } from "./index.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

afterEach(() => {
  document.body.replaceChildren();
  history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
});

describe("local application authentication", () => {
  it.each(["initial", "hashchange"] as const)(
    "strips the bootstrap secret before authentication through %s and never mounts node management before acceptance",
    async (entry) => {
      if (entry === "initial") history.replaceState(null, "", "/#token=synthetic-bootstrap-secret");
      const session = deferred<Response>();
      const fetcher = vi.fn((url: string, init?: RequestInit) => {
        expect(location.hash).toBe("");
        expect(url).toBe("/api/session");
        expect(init?.credentials).toBe("same-origin");
        if (init?.method === "GET") return Promise.resolve(new Response("{}", { status: 401 }));
        expect(JSON.parse(String(init?.body))).toEqual({ token: "synthetic-bootstrap-secret" });
        return session.promise;
      });
      vi.stubGlobal("fetch", fetcher);
      const app = new CypherApplication();
      document.body.append(app);
      await app.updateComplete;
      if (entry === "hashchange") {
        await Promise.all(fetcher.mock.results.map((result) => result.value));
        await app.updateComplete;
        history.replaceState(null, "", "/#token=synthetic-bootstrap-secret");
        globalThis.dispatchEvent(new HashChangeEvent("hashchange"));
        await app.updateComplete;
      }
      expect(location.hash).toBe("");
      expect(app.querySelector(".cypher-manager")).toBeNull();
      expect(app.textContent).not.toContain("synthetic-bootstrap-secret");
      session.resolve(new Response("{}", { status: 401 }));
      await session.promise;
      await app.updateComplete;
      expect(app.querySelector("#cypher-app-token")).not.toBeNull();
      expect(app.querySelector(".cypher-manager")).toBeNull();
      expect(fetcher).toHaveBeenCalledTimes(entry === "initial" ? 1 : 2);
      expect(localStorage.length).toBe(0);
      expect(sessionStorage.length).toBe(0);
    },
  );

  it("clears manually entered tokens before sending and displays a safe sign-in failure", async () => {
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        expect(document.querySelector<HTMLInputElement>("#cypher-app-token")?.value).toBe("");
        expect(JSON.parse(String(init.body))).toEqual({ token: "synthetic-manual-secret" });
      }
      return new Response("{}", { status: 401 });
    });
    vi.stubGlobal("fetch", fetcher);
    const app = new CypherApplication();
    document.body.append(app);
    await Promise.all(fetcher.mock.results.map((result) => result.value));
    await app.updateComplete;
    const input = app.querySelector<HTMLInputElement>("#cypher-app-token")!;
    input.value = "synthetic-manual-secret";
    app.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await Promise.all(fetcher.mock.results.map((result) => result.value));
    await app.updateComplete;
    expect(app.textContent).not.toContain("synthetic-manual-secret");
    expect(app.querySelector('[role="alert"]')?.textContent).toContain("Sign-in failed");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("aborts outstanding RPC work and retires local authority when the server rejects a session", async () => {
    const lost = vi.fn();
    let pendingSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init: RequestInit) => {
        expect(url).toBe("/api/rpc");
        expect(init.credentials).toBe("same-origin");
        const request = JSON.parse(String(init.body));
        if (request.method === "cypher.setup.prepare") {
          pendingSignal = init.signal!;
          return new Promise<Response>((_resolve, reject) => {
            init.signal!.addEventListener("abort", () => reject(init.signal!.reason), {
              once: true,
            });
          });
        }
        return Promise.resolve(new Response("{}", { status: 401 }));
      }),
    );
    const host = new HttpApplicationHost("en", lost);
    const preparation = host.request("cypher.setup.prepare", {});
    const preparationResult = preparation.catch(() => "aborted");
    await expect(host.request("cypher.status", {})).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
    expect(await preparationResult).toBe("aborted");
    expect(pendingSignal?.aborted).toBe(true);
    expect(host.signal.aborted).toBe(true);
    expect(host.connection).toEqual({ connected: false, canRead: false, canAdmin: false });
    expect(lost).toHaveBeenCalledTimes(1);
  });
});
