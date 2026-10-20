import fs from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { AppOperationError, CypherOperations } from "../handlers.js";
import { CypherAppService } from "../service.js";
import { acquireInstance } from "./instance.js";
import { LocalSessions } from "./session.js";

export type CypherAppOptions = { packageRoot: string; stateDir: string };
export type CypherAppAddress = { origin: string; bootstrapUrl: string };

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") {
    throw new HttpError(415, "Use an application/json request.");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 64 * 1024) throw new HttpError(413, "The request is too large.");
    chunks.push(bytes);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "The request must contain valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "The request must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

function hostSupported(): boolean {
  return (
    (process.platform === "linux" && process.arch === "x64") ||
    (process.platform === "darwin" && process.arch === "arm64") ||
    (process.platform === "win32" && process.arch === "x64")
  );
}

export class CypherLocalApp {
  readonly #service: CypherAppService;
  readonly #operations: CypherOperations;
  readonly #sessions = new LocalSessions();
  readonly #server: http.Server;
  #address: CypherAppAddress | undefined;
  #releaseInstance: (() => void) | undefined;
  #started = false;
  #stopping = false;
  #starting: Promise<CypherAppAddress> | undefined;
  #closing: Promise<void> | undefined;

  constructor(readonly options: CypherAppOptions) {
    this.#service = new CypherAppService(options.packageRoot);
    this.#operations = new CypherOperations(this.#service);
    this.#server = http.createServer((request, response) => {
      void this.#handle(request, response).catch(() => {
        if (!response.headersSent)
          json(response, 500, {
            ok: false,
            error: {
              code: "UNAVAILABLE",
              message: "The local operation failed. Check the node status and try again.",
            },
          });
        else response.destroy();
      });
    });
    // Preparing native files and graceful node startup may outlast Node's request default.
    this.#server.requestTimeout = 0;
  }

  listen(port = 0): Promise<CypherAppAddress> {
    if (this.#starting || this.#started || this.#stopping) {
      return Promise.reject(new Error("The local app has already started or is shutting down."));
    }
    this.#starting = this.#start(port);
    return this.#starting;
  }

  async #start(port: number): Promise<CypherAppAddress> {
    if (!hostSupported())
      throw new Error("ColossusX supports Windows x64, macOS ARM64, and Linux x64.");
    if (!Number.isInteger(port) || port < 0 || port > 65535)
      throw new Error("Use a port from 0 through 65535.");
    this.#releaseInstance = await acquireInstance(this.options.stateDir);
    try {
      if (this.#stopping) throw new Error("The local app is shutting down.");
      this.#service.start(this.options.stateDir);
      await new Promise<void>((resolve, reject) => {
        const failed = (error: Error) => {
          this.#server.off("listening", ready);
          reject(error);
        };
        const ready = () => {
          this.#server.off("error", failed);
          resolve();
        };
        this.#server.once("error", failed).once("listening", ready).listen(port, "127.0.0.1");
      });
      if (this.#stopping) throw new Error("The local app is shutting down.");
      const address = this.#server.address();
      if (!address || typeof address === "string")
        throw new Error("The local app could not bind its port.");
      const origin = `http://127.0.0.1:${address.port}`;
      this.#address = { origin, bootstrapUrl: `${origin}/#token=${this.#sessions.token}` };
      this.#started = true;
      return this.#address;
    } catch (error) {
      await this.#service.stop();
      if (this.#server.listening)
        await new Promise<void>((resolve) => this.#server.close(() => resolve()));
      this.#releaseInstance?.();
      this.#releaseInstance = undefined;
      throw error;
    }
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    const address = this.#address;
    if (!address || this.#closing) {
      json(response, 503, {
        ok: false,
        error: { code: "UNAVAILABLE", message: "The app is shutting down." },
      });
      return;
    }
    const expectedHost = new URL(address.origin).host;
    if (request.headers.host !== expectedHost) {
      json(response, 403, {
        ok: false,
        error: { code: "FORBIDDEN", message: "Use the app's local address." },
      });
      return;
    }
    const pathname = request.url?.split("?")[0];
    try {
      if (pathname?.startsWith("/api/")) {
        if (
          request.headers["sec-fetch-site"] === "cross-site" ||
          (request.method === "POST" && request.headers.origin !== address.origin) ||
          (request.headers.origin !== undefined && request.headers.origin !== address.origin)
        ) {
          throw new HttpError(403, "This request must come from the local app.");
        }
        if (pathname === "/api/session" && request.method === "POST") {
          const input = await body(request);
          if (Object.keys(input).some((key) => key !== "token"))
            throw new HttpError(400, "Invalid sign-in request.");
          const id = this.#sessions.authenticate(input.token);
          if (!id)
            throw new HttpError(
              401,
              "The local access token is invalid. Reopen the app's launch address.",
            );
          response.setHeader(
            "Set-Cookie",
            `cypher_session=${id}; HttpOnly; SameSite=Strict; Path=/`,
          );
          json(response, 200, { authenticated: true, methods: this.#operations.methods });
          return;
        }
        const id = this.#sessions.resolve(request.headers.cookie);
        if (!id) throw new HttpError(401, "Sign in to the local app first.");
        if (pathname === "/api/session" && request.method === "GET") {
          json(response, 200, { authenticated: true, methods: this.#operations.methods });
          return;
        }
        if (pathname === "/api/logout" && request.method === "POST") {
          await body(request);
          this.#sessions.revoke(id);
          response.setHeader(
            "Set-Cookie",
            "cypher_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
          );
          json(response, 200, { ok: true });
          return;
        }
        if (pathname === "/api/rpc" && request.method === "POST") {
          const input = await body(request);
          if (
            typeof input.method !== "string" ||
            Object.keys(input).some((key) => !["method", "params"].includes(key))
          )
            throw new HttpError(400, "Invalid operation request.");
          const lifetime = new AbortController();
          const abort = () => lifetime.abort();
          const close = () => {
            if (!response.writableEnded) abort();
          };
          request.once("aborted", abort);
          response.once("close", close);
          try {
            const authority = this.#sessions.authority(id, lifetime.signal);
            const result = await this.#operations.request(
              input.method,
              input.params ?? {},
              authority,
            );
            authority.assertCurrent();
            if (!response.destroyed) json(response, 200, { ok: true, result });
          } finally {
            request.off("aborted", abort);
            response.off("close", close);
          }
          return;
        }
        throw new HttpError(404, "Unknown local API route.");
      }
      if (request.method !== "GET" && request.method !== "HEAD")
        throw new HttpError(405, "Use GET for application assets.");
      const files: Record<string, [string, string]> = {
        "/": ["dist/ui/index.html", "text/html; charset=utf-8"],
        "/app.js": ["dist/ui/app.js", "text/javascript; charset=utf-8"],
        "/app.css": ["dist/ui/app.css", "text/css; charset=utf-8"],
        "/icon.png": ["assets/icon.png", "image/png"],
      };
      const asset = pathname ? files[pathname] : undefined;
      if (!asset) throw new HttpError(404, "Unknown application asset.");
      const bytes = await fs.readFile(path.join(this.options.packageRoot, asset[0]));
      response.writeHead(200, { "Content-Type": asset[1], "Content-Length": bytes.length });
      response.end(request.method === "HEAD" ? undefined : bytes);
    } catch (error) {
      if (response.destroyed) return;
      if (error instanceof HttpError) {
        json(response, error.status, {
          ok: false,
          error: {
            code:
              error.status === 401
                ? "UNAUTHORIZED"
                : error.status === 403
                  ? "FORBIDDEN"
                  : "INVALID_REQUEST",
            message: error.message,
          },
        });
      } else if (error instanceof AppOperationError) {
        const status =
          error.code === "FORBIDDEN"
            ? 403
            : error.code === "INVALID_REQUEST"
              ? 400
              : error.code === "METHOD_NOT_FOUND"
                ? 404
                : 503;
        json(response, status, {
          ok: false,
          error: {
            code: error.code,
            message: error.message,
            ...(error.details ? { details: error.details } : {}),
          },
        });
      } else throw error;
    }
  }

  async close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#stopping = true;
    this.#sessions.close();
    const close = async () => {
      try {
        await this.#starting;
      } catch {
        /* Startup owns its failed-admission cleanup. */
      }
      // Keep custody of native processes and the state lock until shutdown settles.
      await this.#service.stop();
      if (this.#server.listening)
        await new Promise<void>((resolve, reject) =>
          this.#server.close((error) => (error ? reject(error) : resolve())),
        );
      this.#releaseInstance?.();
      this.#releaseInstance = undefined;
    };
    this.#closing = close();
    try {
      await this.#closing;
    } finally {
      this.#closing = undefined;
    }
  }
}

export function createCypherApp(options: CypherAppOptions): CypherLocalApp {
  return new CypherLocalApp(options);
}
