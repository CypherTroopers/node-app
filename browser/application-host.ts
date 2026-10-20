export type ApplicationConnection = {
  connected: boolean;
  canRead: boolean;
  canAdmin: boolean;
};

export type ApplicationHost = {
  readonly signal: AbortSignal;
  readonly connection: ApplicationConnection;
  locale: string;
  request<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<T>;
  subscribe(listener: () => void): () => void;
  redact(text: string): string;
};

export type ApplicationContext = {
  host: ApplicationHost;
  signal: AbortSignal;
  presented: boolean;
};

type RpcReply<T> =
  | { ok: true; result: T }
  | { ok: false; error: { code: string; message: string } };

export class ApplicationRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** The local server owns authentication. This host only projects its current session. */
export class HttpApplicationHost implements ApplicationHost {
  private readonly lifetime = new AbortController();
  private readonly listeners = new Set<() => void>();
  readonly connection = { connected: true, canRead: true, canAdmin: true };
  readonly signal = this.lifetime.signal;

  constructor(
    public locale: string,
    private readonly onAuthenticationLost: () => void,
  ) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  redact(text: string): string {
    return text.replace(/(private\s*key\s*[:=]\s*)?(?:0x)?[0-9a-f]{64}\b/giu, "[redacted]");
  }

  async request<T>(
    method: string,
    params: Record<string, unknown> = {},
    options: { signal?: AbortSignal } = {},
  ): Promise<T> {
    const signal = options.signal ? AbortSignal.any([this.signal, options.signal]) : this.signal;
    signal.throwIfAborted();
    const response = await fetch("/api/rpc", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method, params }),
      signal,
    });
    if (response.status === 401) {
      this.close();
      this.onAuthenticationLost();
      throw new ApplicationRequestError("UNAUTHENTICATED", "Sign in to the local app again.");
    }
    const reply: RpcReply<T> = await response.json();
    signal.throwIfAborted();
    if (!reply.ok) {
      throw new ApplicationRequestError(reply.error.code, this.redact(reply.error.message));
    }
    if (!response.ok) {
      throw new ApplicationRequestError(
        "REQUEST_FAILED",
        "The local app could not complete this request.",
      );
    }
    return reply.result;
  }

  setLocale(locale: string): void {
    this.locale = locale;
    for (const listener of this.listeners) {
      listener();
    }
  }

  close(): void {
    if (this.signal.aborted) {
      return;
    }
    this.connection.connected = false;
    this.connection.canRead = false;
    this.connection.canAdmin = false;
    this.lifetime.abort();
    for (const listener of this.listeners) {
      listener();
    }
    this.listeners.clear();
  }
}
