import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createNodeFixture } from "./browser-host.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const tabs = ["overview", "node", "wallets", "send", "mining", "explorer"];
const signer = `0x${"1".repeat(40)}`;
const second = `0x${"2".repeat(40)}`;
const LOGO_SHA256 = "b0505f6b2b57cd106288797f5cde21fd8461d1e8e59871f205965c8cd358e93d";

/**
 * Caller supplies a task-owned server. baselinePath optionally supplies a before PNG;
 * the default run needs only this repository and records current screens.
 */
export async function runBrowserProof({ bootstrapUrl, baselinePath }) {
  const bootstrap = new URL(bootstrapUrl);
  assert.equal(bootstrap.hostname, "127.0.0.1");
  const base = bootstrap.origin;
  const parent = path.join(root, "artifacts/proof");
  await fs.mkdir(parent, { recursive: true });
  const proof = await fs.mkdtemp(path.join(parent, "standalone-"));
  const report = {
    proof,
    transport:
      "Actual standalone HTTP server with real cookie authentication; connected-wallet scenarios explicitly replace only /api/rpc with deterministic local fixtures.",
    checks: [],
    screenshots: [],
    pageErrors: [],
    baselineIncluded: false,
  };
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-partial-raster", "--disable-gpu-rasterization"],
    });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1400 },
      reducedMotion: "reduce",
      locale: "en-US",
      colorScheme: "dark",
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => report.pageErrors.push(String(error)));
    const check = (message) => report.checks.push(message);
    const capture = async (name) => {
      await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all([...document.images].map((image) => image.decode()));
      });
      await page.mouse.move(0, 0);
      await page.screenshot({ path: path.join(proof, `${name}.png`), animations: "disabled" });
      report.screenshots.push(`${name}.png`);
    };
    const select = async (tab) => {
      await page.locator(`#cypher-tab-${tab}`).click();
      await page.locator(`#cypher-panel-${tab}`).waitFor({ state: "visible" });
      await page.waitForFunction(
        () => !document.querySelector('[data-cypher-action="refresh"]').disabled,
      );
      assert.equal(await page.locator('[role="tabpanel"]:visible').count(), 1);
    };
    await page.goto(base);
    await page.locator("#cypher-app-token").waitFor();
    assert.equal(await page.locator(".cypher-manager").count(), 0);
    await capture("actual-login");
    await page.goto(bootstrapUrl);
    await page.locator(".cypher-manager .settings-page").waitFor();
    assert.equal(new URL(page.url()).hash, "");
    assert.equal(await page.evaluate(async () => (await fetch("/api/session")).status), 200);
    assert.deepEqual(
      (await page.locator('[role="tab"]').allTextContents()).map((text) => text.trim()),
      ["Overview", "Node", "Wallets", "Send", "Mining", "Explorer"],
    );
    const brand = page.locator(".cypher-brand-mark");
    const embedded = await brand.getAttribute("src");
    assert.match(embedded, /^data:image\/png;base64,/);
    const artwork = Buffer.from(embedded.split(",")[1], "base64");
    const canonicalArtwork = await fs.readFile(
      path.join(root, "browser/assets/cypherclaw-mark.png"),
    );
    assert.equal(createHash("sha256").update(canonicalArtwork).digest("hex"), LOGO_SHA256);
    assert.deepEqual(artwork, canonicalArtwork);
    report.logoSha256 = createHash("sha256").update(artwork).digest("hex");
    await select("node");
    assert.equal(await page.locator('[data-cypher-action="start"]').isDisabled(), true);
    assert.match(
      await page.locator('#cypher-panel-node [data-cypher-action="setup-prepare"]').innerText(),
      /Prepare node/,
    );
    await capture("actual-node-not-prepared");
    check(
      "Actual standalone server authenticates the bootstrap link, strips its fragment, serves all six tabs and the unchanged custom logo, and leaves native preparation/start explicit.",
    );
    await page.locator('[data-app-action="logout"]').click();
    await page.locator("#cypher-app-token").waitFor();
    assert.equal(await page.evaluate(async () => (await fetch("/api/session")).status), 401);
    assert.equal(await page.locator(".cypher-manager").count(), 0);
    check("Sign-out revokes the real server session and removes node-management content.");

    // The app shell, HTTP session, built JS/CSS and all DOM interactions stay real.
    // Only the chain/process RPC results below are synthetic; no funds or miner are used.
    let fixture = createNodeFixture();
    await page.route(`${base}/api/rpc`, async (route) => {
      const { method, params } = route.request().postDataJSON();
      try {
        const result = await fixture.request(method, params);
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ ok: true, result }),
        });
      } catch {
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({
            ok: false,
            error: {
              code: "FIXTURE_FAILURE",
              message:
                "Native tools could not be downloaded. Check this computer's network and retry setup.",
            },
          }),
        });
      }
    });
    await page.goto(bootstrapUrl);
    await page.locator(".cypher-manager .settings-page").waitFor();
    await page.waitForFunction(
      () => !document.querySelector('[data-cypher-action="refresh"]').disabled,
    );
    assert.equal(
      fixture.requests.some((row) => row.method === "cypher.setup.prepare"),
      false,
    );
    for (const tab of tabs) {
      await select(tab);
      await capture(`connected-fixture-${tab}`);
    }
    if (baselinePath) {
      await fs.copyFile(path.resolve(baselinePath), path.join(proof, "before-node-baseline.png"));
      report.screenshots.unshift("before-node-baseline.png");
      report.baselineIncluded = true;
    }
    check(
      report.baselineIncluded
        ? "Connected-node fixtures display all six management panels; the caller-supplied before screenshot is included for visual comparison. The connected data is synthetic."
        : "Connected-node fixtures display all six management panels. No before screenshot was supplied; this run records current screens only. The connected data is synthetic.",
    );
    await select("wallets");
    await page.locator("#cypher-wallet").selectOption(second);
    await page.locator('[data-cypher-action="lock"]').click();
    await page.waitForFunction(
      () => !document.querySelector('[data-cypher-action="refresh"]').disabled,
    );
    assert.deepEqual(fixture.requests.find((row) => row.method === "cypher.accounts.lock").params, {
      address: second,
    });
    assert.equal(
      fixture.requests.some((row) => row.method === "cypher.accounts.select"),
      false,
    );
    await page.locator("#cypher-panel-wallets summary").click();
    await page.locator('[data-wallet-action="generate"]').click();
    await page.locator('[data-wallet-value="address"]').waitFor();
    assert.equal(
      await page.locator('[data-wallet-value="privateKey"]').innerText(),
      "••••••••••••••••••••••••",
    );
    await capture("connected-fixture-wallet-generator");
    await page.locator('[data-wallet-action="reveal"]').click();
    assert.equal(
      await page.locator('[data-wallet-value="privateKey"]').innerText(),
      `0x${"0".repeat(63)}1`,
    );
    await page.locator('[data-app-action="logout"]').click();
    await page.locator("#cypher-app-token").waitFor();
    assert.equal((await page.locator("body").innerText()).includes(`0x${"0".repeat(63)}1`), false);
    check(
      "Selected-wallet mutations stay separate from signer selection; generated private keys are masked and are removed synchronously on sign-out.",
    );

    fixture = createNodeFixture();
    await page.goto(bootstrapUrl);
    await page.locator(".cypher-manager .settings-page").waitFor();
    await select("send");
    await page.locator("#cypher-send-wallet").selectOption(second);
    await page.locator("#cypher-send-recipient").fill(signer);
    await page.locator("#cypher-send-amount").fill("0.000000000000000001");
    await page.locator('[data-cypher-action="prepare"]').click();
    await page.locator("#cypher-send-confirm").waitFor();
    assert.equal(await page.locator('[data-cypher-action="send"]').isDisabled(), true);
    await capture("connected-fixture-send-review");
    await page.locator("#cypher-send-confirm").check();
    await page.locator("#cypher-send-password").fill("fixture-password");
    await page.locator('[data-cypher-action="send"]').click();
    await page.getByText("Included · awaiting finality", { exact: true }).waitFor();
    assert.equal(await page.locator("#cypher-send-password").count(), 0);
    fixture.finality();
    await page.locator('[data-cypher-action="refresh"]').click();
    await page.getByText("Complete", { exact: true }).waitFor();
    assert.equal(
      fixture.requests.filter((row) => row.method === "cypher.transfers.send").length,
      1,
    );
    check(
      "Synthetic transfer flow still requires fee confirmation, submits once, clears its password, and waits for finality before Complete.",
    );
    await select("mining");
    await page.locator("#cypher-threads").fill("2");
    await page.locator("#cypher-mining-password").fill("fixture-password");
    await page.locator('[data-cypher-action="mining-start"]').click();
    await page.waitForFunction(
      () => !document.querySelector('[data-cypher-action="refresh"]').disabled,
    );
    assert.deepEqual(fixture.requests.find((row) => row.method === "cypher.mining.start").params, {
      threads: 2,
      signer,
      password: "fixture-password",
    });
    assert.equal(await page.locator("#cypher-mining-password").inputValue(), "");
    await page.locator("#cypher-recipient").fill(second);
    await page.locator("#cypher-reward-password").fill("fixture-password");
    await page.locator('[data-cypher-action="reward-set"]').click();
    await page.waitForFunction(
      () => !document.querySelector('[data-cypher-action="refresh"]').disabled,
    );
    assert.deepEqual(fixture.requests.find((row) => row.method === "cypher.reward.set").params, {
      signer,
      recipient: second,
      password: "fixture-password",
    });
    await select("explorer");
    await page.locator("#cypher-explorer-query").fill(signer);
    assert.equal(
      await page.locator("#cypher-panel-explorer a").first().getAttribute("href"),
      `https://colossusx.make-cph-great-again.community/address/${signer}`,
    );
    check(
      "Synthetic mining/reward calls preserve separate signer A and recipient B; explorer links retain chain-specific validation.",
    );
    await page.setViewportSize({ width: 390, height: 844 });
    for (const tab of ["node", "wallets", "mining"]) {
      await select(tab);
      await capture(`mobile-fixture-${tab}`);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
    }
    check(
      "The standalone toolbar and node, wallet and mining panels fit a 390px viewport without horizontal document overflow.",
    );

    await page.setViewportSize({ width: 1440, height: 1400 });
    fixture = createNodeFixture({ missing: true });
    await page.goto(bootstrapUrl);
    await page.locator(".cypher-manager .settings-page").waitFor();
    await page.getByRole("combobox", { name: "Language" }).selectOption("ja");
    const prepare = page.locator('#cypher-panel-overview [data-cypher-action="setup-prepare"]');
    assert.match(await prepare.innerText(), /ノードを準備/);
    await capture("setup-missing-japanese");
    await prepare.click();
    await page.locator('#cypher-panel-overview [data-cypher-action="setup-refresh"]').click();
    await page.getByText("1,048,576 / 2,097,152 B", { exact: true }).first().waitFor();
    assert.equal(await prepare.isDisabled(), true);
    await capture("setup-preparing-japanese");
    fixture.finishSetup(true);
    await prepare.waitFor({ state: "visible" });
    await page.waitForFunction(
      () =>
        !document.querySelector('#cypher-panel-overview [data-cypher-action="setup-prepare"]')
          .disabled,
    );
    await capture("setup-failure-japanese");
    await prepare.click();
    await page.locator('#cypher-panel-overview [data-cypher-action="setup-refresh"]').click();
    await page.getByText("1,048,576 / 2,097,152 B", { exact: true }).first().waitFor();
    fixture.finishSetup();
    await select("node");
    await page.waitForFunction(
      () => !document.querySelector('[data-cypher-action="start"]').disabled,
    );
    assert.equal(
      fixture.requests.some((row) => row.method === "cypher.start"),
      false,
    );
    await capture("setup-ready-japanese");
    check(
      "Fixture-only native preparation shows missing, progress, failure/retry and ready states in Japanese, without starting the node automatically.",
    );
    assert.deepEqual(report.pageErrors, []);
    report.success = true;
    await writeGallery(proof, report.screenshots, report.baselineIncluded);
    await page.goto(`file://${path.join(proof, "gallery.html")}`);
    const feedback = page.locator('[data-example="actual-node-not-prepared"]');
    await feedback.fill("Synthetic feedback persistence check");
    await page.reload();
    assert.equal(await feedback.inputValue(), "Synthetic feedback persistence check");
    await feedback.fill("");
    await page.locator("#export-feedback").click();
    assert.match(await page.locator("#feedback-export").inputValue(), /actual-node-not-prepared/);
    check(
      "The screenshot gallery retains example feedback across reload and exports stable example labels.",
    );
    await context.close();
  } catch (error) {
    report.success = false;
    report.error = String(error);
    throw error;
  } finally {
    await fs.writeFile(path.join(proof, "report.json"), JSON.stringify(report, null, 2));
    await browser?.close();
    console.log(JSON.stringify({ proof, success: report.success, checks: report.checks.length }));
  }
  return report;
}

async function writeGallery(proof, screenshots, baselineIncluded) {
  const examples = screenshots.map((name) => ({ id: name.replace(/\.png$/, ""), image: name }));
  await fs.writeFile(
    path.join(proof, "gallery.html"),
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cypher standalone UI review</title><style>body{margin:24px;background:#101218;color:#f0f2f8;font:15px system-ui}section{margin-block:32px}img{display:block;max-width:100%;border:1px solid #444}textarea{display:block;width:min(100%,800px);min-height:70px;margin-block:12px}label{display:block}button{padding:10px}</style><h1>Cypher standalone UI review</h1><p>Actual standalone authentication and missing-node screens are labeled “actual”. Connected-node and preparation-progress screens use deterministic RPC fixtures; no live chain, funds or miner is involved. ${baselineIncluded ? "The caller-supplied before screenshot is included for comparison." : "No before screenshot was supplied; this gallery records current screens only."}</p>${examples.map(({ id, image }) => `<section id="${id}"><h2>${id}</h2><img src="${image}" alt="${id}"><label for="feedback-${id}">Feedback: ${id}</label><textarea id="feedback-${id}" data-example="${id}"></textarea></section>`).join("")}<button id="export-feedback">Copy feedback</button><label for="feedback-export">Feedback export</label><textarea id="feedback-export" readonly></textarea><script>const key="cypher-standalone-ui-gallery-v1";const inputs=[...document.querySelectorAll("[data-example]")];const saved=JSON.parse(localStorage.getItem(key)||"{}");for(const input of inputs){input.value=saved[input.dataset.example]||"";input.addEventListener("input",()=>localStorage.setItem(key,JSON.stringify(Object.fromEntries(inputs.map(field=>[field.dataset.example,field.value])))))}document.querySelector("#export-feedback").addEventListener("click",async()=>{const text=inputs.map(input=>"## "+input.dataset.example+"\\n"+(input.value||"No feedback")+"\\n").join("\\n");document.querySelector("#feedback-export").value=text;try{await navigator.clipboard.writeText(text)}catch{document.querySelector("#feedback-export").select()}})</script></html>`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2]) {
    const config = JSON.parse(await fs.readFile(process.argv[2], "utf8"));
    await runBrowserProof(config);
  } else {
    const { createCypherApp } = await import("../dist/server.js");
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "cypher-node-browser-proof-"));
    const application = createCypherApp({ packageRoot: root, stateDir });
    try {
      const { bootstrapUrl } = await application.listen(0);
      await runBrowserProof({ bootstrapUrl });
    } finally {
      await application.close();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  }
}
