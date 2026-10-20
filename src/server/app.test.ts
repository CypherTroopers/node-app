import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCypherApp, type CypherLocalApp } from "./app.js";
import { LocalSessions } from "./session.js";

describe("local application HTTP boundary", () => {
  let app: CypherLocalApp;
  let stateDir: string;
  let origin: string;
  let token: string;
  beforeAll(async () => {
    // The application owns this complete isolated state lifecycle; no OpenClaw state is used.
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "colossusx-http-test-"));
    app = createCypherApp({
      packageRoot: fileURLToPath(new URL("../../", import.meta.url)),
      stateDir,
    });
    const address = await app.listen(0);
    origin = address.origin;
    token = new URLSearchParams(new URL(address.bootstrapUrl).hash.slice(1)).get("token")!;
  });
  afterAll(async () => {
    await app?.close();
    if (stateDir) await fs.rm(stateDir, { recursive: true, force: true });
  });

  async function login(): Promise<string> {
    const response = await fetch(`${origin}/api/session`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie")!;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    const payload = await response.json();
    expect(payload.authenticated).toBe(true);
    expect(payload).not.toHaveProperty("token");
    return cookie.split(";")[0]!;
  }

  async function rpc(cookie: string, method: string, params: unknown = {}) {
    return fetch(`${origin}/api/rpc`, {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ method, params }),
    });
  }

  it("serves the app without exposing state, and requires a local session for operations", async () => {
    const page = await fetch(origin);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("ColossusX Node Manager");
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect((await fetch(`${origin}/api/session`)).status).toBe(401);
    expect((await rpc("", "cypher.status")).status).toBe(401);
    expect((await fetch(`${origin}/assets/../../instance.sqlite`)).status).toBe(404);
    // Fetch derives Host from its URL, so exercise the literal HTTP header boundary.
    const rebinding = await new Promise<number | undefined>((resolve, reject) => {
      http
        .get(origin, { headers: { Host: "attacker.invalid" } }, (response) => {
          response.resume();
          resolve(response.statusCode);
        })
        .once("error", reject);
    });
    expect(rebinding).toBe(403);
  });

  it("rejects foreign origin even with a valid cookie, and admits only validated operations", async () => {
    const cookie = await login();
    const foreign = await fetch(`${origin}/api/rpc`, {
      method: "POST",
      headers: {
        Origin: "https://attacker.invalid",
        Cookie: cookie,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ method: "cypher.setup.prepare", params: {} }),
    });
    expect(foreign.status).toBe(403);
    expect(
      (await rpc(cookie, "cypher.accounts.unlock", { address: "bad", password: "synthetic" }))
        .status,
    ).toBe(400);
    expect((await rpc(cookie, "unknown.operation")).status).toBe(404);
    const setup = await rpc(cookie, "cypher.setup.status");
    expect(setup.status).toBe(200);
    expect(await setup.json()).toMatchObject({
      ok: true,
      result: { state: "missing", node: { ready: false } },
    });
    await expect(fs.stat(path.join(stateDir, "native"))).rejects.toMatchObject({ code: "ENOENT" });
    const history = await rpc(cookie, "cypher.transfers.list");
    expect(await history.json()).toEqual({ ok: true, result: { transfers: [] } });
  });

  it("revokes the server-held session on sign-out", async () => {
    const cookie = await login();
    const logout = await fetch(`${origin}/api/logout`, {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(logout.status).toBe(200);
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await rpc(cookie, "cypher.status")).status).toBe(401);
  });

  it("refuses a second server for the same native state directory", async () => {
    const duplicate = createCypherApp({ packageRoot: ".", stateDir });
    await expect(duplicate.listen(0)).rejects.toThrow("already open");
    await duplicate.close();
  });

  it("joins startup before releasing shutdown custody", async () => {
    const isolated = path.join(stateDir, "startup-race");
    const local = createCypherApp({ packageRoot: ".", stateDir: isolated });
    const starting = local.listen(0).then(() => "listening");
    const rejected = expect(starting).rejects.toThrow("shutting down");
    try {
      await local.close();
      await rejected;
    } finally {
      await local.close();
    }
    const replacement = createCypherApp({ packageRoot: ".", stateDir: isolated });
    try {
      await replacement.listen(0);
    } finally {
      await replacement.close();
    }
  });
});

it("revocation retires already-captured authority before a deferred effect", async () => {
  const sessions = new LocalSessions();
  const id = sessions.authenticate(sessions.token)!;
  const authority = sessions.authority(id, new AbortController().signal);
  authority.assertCurrent();
  sessions.revoke(id);
  await Promise.resolve();
  expect(authority.signal?.aborted).toBe(true);
  expect(() => authority.assertCurrent()).toThrow("session has ended");
  sessions.close();
});
