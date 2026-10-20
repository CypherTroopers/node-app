import { html, LitElement, nothing } from "lit";
import { HttpApplicationHost, type ApplicationContext } from "./application-host.ts";
import mark from "./assets/cypherclaw-mark.png";
import { CypherPage } from "./node-page.ts";
import "./style.css";

export function mountCypher(container: HTMLElement, context: ApplicationContext) {
  const page = new CypherPage();
  page.className = "cypher-manager";
  page.updateContext(context);
  container.append(page);
  const dispose = () => page.remove();
  context.signal.addEventListener("abort", dispose, { once: true });
  return {
    update(next: ApplicationContext) {
      page.updateContext(next);
    },
    dispose() {
      context.signal.removeEventListener("abort", dispose);
      dispose();
    },
  };
}

export class CypherApplication extends LitElement {
  static override properties = {
    phase: { state: true },
    locale: { state: true },
    error: { state: true },
  };
  private phase: "checking" | "signed-out" | "signing-in" | "signed-in" = "checking";
  private locale = navigator.language.toLowerCase().startsWith("ja") ? "ja" : "en";
  private error: string | null = null;
  private application: HttpApplicationHost | null = null;
  private view: ReturnType<typeof mountCypher> | null = null;
  private readonly lifetime = new AbortController();
  private authentication: AbortController | null = null;
  private started = false;
  private bootstrapToken: string | null;

  constructor() {
    super();
    this.bootstrapToken = this.takeBootstrapToken();
  }

  private takeBootstrapToken(): string | null {
    const fragment = new URLSearchParams(location.hash.slice(1));
    const token = fragment.get("token");
    // Remove the secret before authentication, rendering links, or making any request.
    if (location.hash) {
      history.replaceState(null, "", `${location.pathname}${location.search}`);
    }
    return token;
  }

  private readonly onHashChange = () => {
    const token = this.takeBootstrapToken();
    if (token) {
      this.retire();
      void this.authenticate(token);
    }
  };

  override createRenderRoot() {
    return this;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    globalThis.addEventListener("hashchange", this.onHashChange);
    globalThis.addEventListener("pagehide", this.onPageHide);
    globalThis.addEventListener("pageshow", this.onPageShow);
    if (!this.started) {
      this.started = true;
      const token = this.bootstrapToken;
      this.bootstrapToken = null;
      void this.authenticate(token);
    }
  }

  private readonly onPageHide = () => {
    this.authentication?.abort();
    this.retire();
    this.phase = "signed-out";
  };

  private readonly onPageShow = (event: PageTransitionEvent) => {
    if (event.persisted) {
      void this.authenticate(null);
    }
  };

  override disconnectedCallback(): void {
    globalThis.removeEventListener("hashchange", this.onHashChange);
    globalThis.removeEventListener("pagehide", this.onPageHide);
    globalThis.removeEventListener("pageshow", this.onPageShow);
    this.authentication?.abort();
    this.retire();
    this.lifetime.abort();
    super.disconnectedCallback();
  }

  private text(english: string, japanese: string): string {
    return this.locale === "ja" ? japanese : english;
  }

  private retire(): void {
    this.application?.close();
    this.application = null;
    this.view?.dispose();
    this.view = null;
  }

  private async authenticate(token: string | null): Promise<void> {
    this.authentication?.abort();
    const authentication = new AbortController();
    this.authentication = authentication;
    this.phase = token ? "signing-in" : "checking";
    this.error = null;
    try {
      const response = await fetch("/api/session", {
        method: token ? "POST" : "GET",
        credentials: "same-origin",
        headers: token ? { "content-type": "application/json" } : {},
        ...(token ? { body: JSON.stringify({ token }) } : {}),
        signal: AbortSignal.any([this.lifetime.signal, authentication.signal]),
      });
      if (authentication.signal.aborted || this.lifetime.signal.aborted) {
        return;
      }
      if (!response.ok) {
        this.phase = "signed-out";
        if (token) {
          this.error = this.text(
            "Sign-in failed. Reopen the desktop app, or use the local server token.",
            "ログインできませんでした。デスクトップアプリを再度開くか、ローカルサーバーのトークンを使用してください。",
          );
        }
        return;
      }
      const session: { authenticated?: boolean } = await response.json();
      if (authentication.signal.aborted || this.lifetime.signal.aborted) {
        return;
      }
      if (session.authenticated !== true) {
        throw new Error("Invalid session response");
      }
      this.retire();
      this.application = new HttpApplicationHost(this.locale, () => {
        this.retire();
        this.phase = "signed-out";
        this.error = this.text(
          "Your local session ended. Sign in again.",
          "ローカルセッションが終了しました。再度ログインしてください。",
        );
      });
      this.phase = "signed-in";
      await this.updateComplete;
      if (
        this.application &&
        this.authentication === authentication &&
        !authentication.signal.aborted
      ) {
        this.view = mountCypher(this.querySelector<HTMLElement>(".cypher-app-workspace")!, {
          host: this.application,
          signal: this.application.signal,
          presented: true,
        });
      }
    } catch {
      if (!authentication.signal.aborted && !this.lifetime.signal.aborted) {
        this.phase = "signed-out";
        this.error = this.text(
          "Cannot reach the local app. Check that it is still running.",
          "ローカルアプリに接続できません。起動しているか確認してください。",
        );
      }
    }
  }

  private async logout(): Promise<void> {
    this.retire();
    this.phase = "signing-in";
    this.error = null;
    try {
      const response = await fetch("/api/logout", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: "{}",
        signal: this.lifetime.signal,
      });
      if (!response.ok) {
        throw new Error("Logout failed");
      }
    } catch {
      this.error = this.text(
        "Could not confirm sign-out. Close this window and restart the app to end local sessions.",
        "ログアウトを確認できませんでした。ウィンドウを閉じてアプリを再起動するとローカルセッションを終了できます。",
      );
    } finally {
      if (!this.lifetime.signal.aborted) {
        this.phase = "signed-out";
      }
    }
  }

  override render() {
    const waiting = this.phase === "checking" || this.phase === "signing-in";
    return html`
      <header class="cypher-app-toolbar">
        <div class="cypher-app-brand">
          <img src=${mark} width="28" height="28" alt="" /><span>Cypher Node</span>
        </div>
        <div class="cypher-app-tools">
          <span class="cypher-app-local">${this.text("Local app", "ローカルアプリ")}</span>
          <label class="cypher-app-language"
            >${this.text("Language", "言語")}
            <select
              aria-label=${this.text("Language", "言語")}
              .value=${this.locale}
              @change=${(event: Event) => {
                this.locale = (event.target as HTMLSelectElement).value;
                this.application?.setLocale(this.locale);
                if (this.application)
                  this.view?.update({
                    host: this.application,
                    signal: this.application.signal,
                    presented: true,
                  });
              }}
            >
              <option value="en">English</option>
              <option value="ja">日本語</option>
            </select>
          </label>
          ${this.phase === "signed-in" ? html`<button class="btn" type="button" data-app-action="logout" @click=${() => void this.logout()}>${this.text("Sign out", "ログアウト")}</button>` : nothing}
        </div>
      </header>
      ${this.error ? html`<p class="cypher-app-message" role="alert">${this.error}</p>` : nothing}
      ${
        this.phase === "signed-in"
          ? html`<main class="cypher-app-workspace"></main>`
          : html`
              <main class="cypher-app-login">
                <h1>${this.text("Cypher Node", "Cypher Node")}</h1>
                ${
                  waiting
                    ? html`<p role="status">
                        ${this.text("Connecting to the local app…", "ローカルアプリに接続中…")}
                      </p>`
                    : html`
                        <p>
                          ${this.text("Close and reopen the desktop app to sign in again. When using the local server, enter the access token shown in its terminal.", "デスクトップアプリは閉じて再度開くとログインできます。ローカルサーバーを使用する場合は、ターミナルに表示されたアクセストークンを入力してください。")}
                        </p>
                        <form
                          @submit=${(event: SubmitEvent) => {
                            event.preventDefault();
                            const input =
                              this.querySelector<HTMLInputElement>("#cypher-app-token")!;
                            const token = input.value.trim();
                            input.value = "";
                            if (token) void this.authenticate(token);
                          }}
                        >
                          <label for="cypher-app-token"
                            >${this.text("Access token", "アクセストークン")}</label
                          >
                          <input
                            id="cypher-app-token"
                            name="token"
                            type="password"
                            autocomplete="off"
                            autocapitalize="off"
                            spellcheck="false"
                            required
                          />
                          <button class="btn primary" type="submit">
                            ${this.text("Sign in", "ログイン")}
                          </button>
                        </form>
                      `
                }
              </main>
            `
      }
    `;
  }
}

customElements.define("cypher-node-application", CypherApplication);
const container = document.querySelector("#app");
if (container) {
  container.append(new CypherApplication());
}
