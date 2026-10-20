import { randomBytes, timingSafeEqual } from "node:crypto";
import type { CypherAuthority } from "../authority.js";

type Session = { id: string; lifetime: AbortController };

/** Sessions are process-owned capabilities; neither bootstrap nor cookies are persisted. */
export class LocalSessions {
  readonly token = randomBytes(32).toString("base64url");
  readonly #sessions = new Map<string, Session>();
  readonly #lifetime = new AbortController();

  authenticate(token: unknown): string | undefined {
    if (this.#lifetime.signal.aborted || typeof token !== "string" || !/^[\w-]{43}$/.test(token)) {
      return undefined;
    }
    if (!timingSafeEqual(Buffer.from(token), Buffer.from(this.token))) return undefined;
    const id = randomBytes(32).toString("base64url");
    this.#sessions.set(id, { id, lifetime: new AbortController() });
    return id;
  }

  resolve(cookie: string | undefined): string | undefined {
    const id = cookie
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("cypher_session="))
      ?.slice("cypher_session=".length);
    return id && this.#sessions.has(id) && !this.#lifetime.signal.aborted ? id : undefined;
  }

  authority(id: string, requestSignal: AbortSignal): CypherAuthority {
    const session = this.#sessions.get(id);
    if (!session) throw new Error("The local session has ended.");
    const signal = AbortSignal.any([requestSignal, session.lifetime.signal, this.#lifetime.signal]);
    return {
      signal,
      assertCurrent: () => {
        if (signal.aborted || this.#sessions.get(id) !== session) {
          throw new Error("The local session has ended. Sign in again.");
        }
      },
    };
  }

  revoke(id: string): void {
    const session = this.#sessions.get(id);
    this.#sessions.delete(id);
    session?.lifetime.abort();
  }

  close(): void {
    this.#lifetime.abort();
    for (const id of this.#sessions.keys()) this.revoke(id);
  }
}
