import { vi } from "vitest";
import type { ApplicationContext, ApplicationHost } from "./application-host.ts";

export function createTestHost(
  response: (method: string, params: Record<string, unknown>) => Promise<unknown>,
) {
  const lifetime = new AbortController();
  const listeners = new Set<() => void>();
  const connection = { connected: true, canRead: true, canAdmin: true };
  const host: ApplicationHost = {
    signal: lifetime.signal,
    locale: "en",
    redact: (value) => value,
    connection,
    async request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      return structuredClone(await response(method, params)) as T;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const request = vi.spyOn(host, "request");
  return {
    host,
    request,
    connection,
    lifetime,
    notify() {
      for (const listener of listeners) listener();
    },
    context: { host, signal: lifetime.signal, presented: true } satisfies ApplicationContext,
  };
}
