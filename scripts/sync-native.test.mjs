import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execute = promisify(execFile);
const distributionCommit = "a".repeat(40);
const sourceCommit = "b".repeat(40);
const treeSha = "c".repeat(40);
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const payloads = {
  "cypher-linux-amd64": "abc",
  "cypher-darwin-arm64": "hello",
  "cypher.exe": "test",
  "runtime-one.dll": "a",
  "runtime-two.dll": "b",
};
let directory;
let fixture;
let files;
let pinFile;

function upstream() {
  const records = {};
  for (const [target, binary] of [
    ["linux-amd64", "cypher-linux-amd64"],
    ["darwin-arm64", "cypher-darwin-arm64"],
    ["windows-amd64", "cypher.exe"],
  ]) {
    const [goos, goarch] = target.split("-");
    const manifest = `source_sha=${sourceCommit}\ngoos=${goos}\ngoarch=${goarch}\nbinary=${binary}\nbinary_sha256=${sha256(payloads[binary])}\nipc_transaction_finality_method=eth_getTransactionFinality\nipc_transaction_finality_transport=ipc\n`;
    const buildInfo = `\tbuild\tGOOS=${goos}\n\tbuild\tGOARCH=${goarch}\n`;
    const names = [binary, ...(goos === "windows" ? ["runtime-one.dll", "runtime-two.dll"] : [])];
    const sums =
      [
        ...names.map((name) => `${sha256(payloads[name])}  ${name}`),
        `${sha256(manifest)}  manifest.txt`,
        `${sha256(buildInfo)}  go-build-info.txt`,
      ].join("\n") + "\n";
    records[`build/provenance/${target}/manifest.txt`] = manifest;
    records[`build/provenance/${target}/go-build-info.txt`] = buildInfo;
    records[`build/provenance/${target}/SHA256SUMS`] = sums;
  }
  for (const [name, bytes] of Object.entries(payloads)) records[`build/bin/${name}`] = bytes;
  return records;
}

beforeEach(async () => {
  // openclaw-temp-dir: allow independent CLI fixtures without core test helpers.
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "cypher-native-sync-"));
  await fs.mkdir(path.join(directory, "scripts"));
  await fs.mkdir(path.join(directory, "src/native"), { recursive: true });
  await fs.copyFile(
    new URL("./sync-native.mjs", import.meta.url),
    path.join(directory, "scripts/sync-native.mjs"),
  );
  pinFile = path.join(directory, "src/native/node-pins.ts");
  await fs.writeFile(pinFile, "preserved known-good node pins\n");
  files = upstream();
  fixture = {
    files,
    distributionCommit,
    sourceCommit,
    treeSha,
    comparisonFiles: [{ filename: "build/bin/cypher.exe" }],
  };
});
afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

async function invoke(extra = []) {
  await fs.writeFile(path.join(directory, "input.json"), JSON.stringify(fixture));
  await fs.writeFile(
    path.join(directory, "preload.mjs"),
    `
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
const input=JSON.parse(await fs.readFile(new URL('./input.json',import.meta.url),'utf8'));
const requests=[];
const digest=(text)=>createHash('sha1').update('blob '+Buffer.byteLength(text)+'\\0'+text).digest('hex');
globalThis.fetch=async (value,options)=>{
 const url=new URL(value); requests.push({url:url.href,authorized:Boolean(options.headers.Authorization)});
 await fs.writeFile(new URL('./requests.json',import.meta.url),JSON.stringify(requests));
 let body;
 if(url.hostname==='api.github.com') {
  if(url.pathname.includes('/commits/')) body={sha:input.distributionCommit,commit:{tree:{sha:input.treeSha}}};
  else if(url.pathname.includes('/git/trees/')) body={truncated:false,tree:Object.entries(input.files).filter(([name])=>name!==input.omit).map(([name,bytes])=>({path:name,type:'blob',mode:'100644',size:Buffer.byteLength(bytes),sha:digest(bytes)}))};
  else if(url.pathname.includes('/compare/')) body={status:'ahead',behind_by:0,merge_base_commit:{sha:input.sourceCommit},files:input.comparisonFiles};
  else throw new Error('Unexpected API fixture URL');
  return new Response(JSON.stringify(body));
 }
 const prefix='/CypherTroopers/cypher/'+input.distributionCommit+'/';
 if(url.hostname!=='raw.githubusercontent.com'||!url.pathname.startsWith(prefix)) throw new Error('Mutable or foreign raw URL');
 const name=url.pathname.slice(prefix.length);
 return new Response(input.corrupt===name?'BAD':input.files[name]);
};
`,
  );
  try {
    const result = await execute(
      process.execPath,
      [
        "--import",
        path.join(directory, "preload.mjs"),
        path.join(directory, "scripts/sync-native.mjs"),
        "--ref",
        "FHS-D",
        "--receipt",
        path.join(directory, "receipt.json"),
        ...extra,
      ],
      {
        cwd: directory,
        env: { ...process.env, GITHUB_TOKEN: "fixture-token-must-stay-private" },
        maxBuffer: 64 * 1024,
      },
    );
    return { code: 0, ...result };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

describe("Actions native synchronization CLI", () => {
  it("resolves once, validates producer bytes, and atomically generates shared three-OS pins without native files", async () => {
    const result = await invoke();
    expect(result.code).toBe(0);
    const receipt = JSON.parse(await fs.readFile(path.join(directory, "receipt.json"), "utf8"));
    expect(receipt).toMatchObject({ distributionCommit, sourceCommit });
    expect(receipt.targets["linux-amd64"][0]).toMatchObject({
      bytes: 3,
      sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    });
    expect(receipt.targets["darwin-arm64"][0]).toMatchObject({
      bytes: 5,
      sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    });
    expect(
      receipt.targets["windows-amd64"]
        .filter((file) => file.path.endsWith(".dll"))
        .map((file) => file.path),
    ).toEqual(["build/bin/runtime-one.dll", "build/bin/runtime-two.dll"]);
    const requests = JSON.parse(await fs.readFile(path.join(directory, "requests.json"), "utf8"));
    expect(requests.filter((request) => request.url.includes("/commits/"))).toHaveLength(1);
    expect(
      requests
        .filter((request) => request.url.includes("raw.githubusercontent.com"))
        .every((request) => request.url.includes(distributionCommit) && !request.authorized),
    ).toBe(true);
    expect(await fs.readdir(path.dirname(pinFile))).toEqual(["node-pins.ts"]);
    expect(await fs.readFile(pinFile, "utf8")).toContain(
      `distributionCommit: "${distributionCommit}"`,
    );
    expect((await invoke(["--check"])).code).toBe(0);
    expect(result.stdout + result.stderr + JSON.stringify(receipt)).not.toContain(
      "fixture-token-must-stay-private",
    );
  });

  it.each([
    [
      "missing native file",
      () => {
        fixture.omit = "build/bin/runtime-two.dll";
      },
      "checksum inventory",
    ],
    [
      "malformed checksums",
      () => {
        files["build/provenance/linux-amd64/SHA256SUMS"] = "invalid\n";
      },
      "SHA256SUMS",
    ],
    [
      "mismatched native digest",
      () => {
        fixture.corrupt = "build/bin/cypher-linux-amd64";
      },
      "Git blob",
    ],
    [
      "producer checksum disagrees with intact binary",
      () => {
        const name = "build/provenance/linux-amd64/manifest.txt";
        const sums = "build/provenance/linux-amd64/SHA256SUMS";
        const original = files[name];
        files[name] = original.replace(sha256(payloads["cypher-linux-amd64"]), "0".repeat(64));
        files[sums] = files[sums]
          .replace(sha256(payloads["cypher-linux-amd64"]), "0".repeat(64))
          .replace(sha256(original), sha256(files[name]));
      },
      "native digest disagrees",
    ],
    [
      "mixed source builds",
      () => {
        files["build/provenance/darwin-arm64/manifest.txt"] = files[
          "build/provenance/darwin-arm64/manifest.txt"
        ].replace(sourceCommit, "d".repeat(40));
      },
      "source commit",
    ],
    [
      "incompatible IPC contract",
      () => {
        files["build/provenance/linux-amd64/manifest.txt"] = files[
          "build/provenance/linux-amd64/manifest.txt"
        ].replace("eth_getTransactionFinality", "eth_getUnknownFinality");
      },
      "IPC transaction-finality",
    ],
    [
      "source changed after build",
      () => {
        fixture.comparisonFiles = [{ filename: "cmd/cypher/main.go" }];
      },
      "source changed",
    ],
  ])("preserves good pins and emits no receipt after %s", async (_name, mutate, message) => {
    mutate();
    const result = await invoke();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(message);
    expect(result.stdout + result.stderr).not.toContain("fixture-token-must-stay-private");
    expect(await fs.readFile(pinFile, "utf8")).toBe("preserved known-good node pins\n");
    await expect(fs.stat(path.join(directory, "receipt.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it("checks generation drift without overwriting the checked-in pins", async () => {
    const result = await invoke(["--check"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Generated node pins differ");
    expect(await fs.readFile(pinFile, "utf8")).toBe("preserved known-good node pins\n");
    await expect(fs.stat(path.join(directory, "receipt.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
