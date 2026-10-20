import type { CypherAuthority } from "./cypher/operations-contract.js";
export type { CypherAuthority } from "./cypher/operations-contract.js";

export class CypherAuthorityError extends Error {
  constructor() {
    super("The request is no longer authorized. Reopen Cypher and try again.");
    this.name = "CypherAuthorityError";
  }
}

/** The transport owns the session; the app owns the current service generation. */
export function createRequestAuthority(
  session: CypherAuthority,
  serviceSignal: AbortSignal,
): CypherAuthority & { signal: AbortSignal } {
  const signal = AbortSignal.any([serviceSignal, ...(session.signal ? [session.signal] : [])]);
  return {
    signal,
    assertCurrent() {
      try {
        signal.throwIfAborted();
        session.assertCurrent();
      } catch {
        throw new CypherAuthorityError();
      }
    },
  };
}
