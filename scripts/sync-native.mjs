#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repository = "CypherTroopers/cypher";
const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, "src/native/node-pins.ts");
const targets = ["linux-amd64", "darwin-arm64", "windows-amd64"];
const records = ["manifest.txt", "go-build-info.txt", "SHA256SUMS"];
const commitPattern = /^[a-f0-9]{40}$/;
const namePattern = /^[a-zA-Z0-9][a-zA-Z0-9.+_-]*$/;

class SyncError extends Error {}

function requireValue(condition, message) {
  if (!condition) throw new SyncError(message);
}

async function read(url, { headers = {}, limit, collect = true, gitSha } = {}) {
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(10 * 60 * 1000),
    headers: { "accept-encoding": "identity", ...headers },
  });
  requireValue(response.ok && response.body, `Upstream request failed: HTTP ${response.status}.`);
  const sha256 = createHash("sha256");
  const blob = gitSha ? createHash("sha1").update(`blob ${limit}\0`) : undefined;
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    requireValue(bytes <= limit, "Upstream response exceeded its declared size.");
    sha256.update(chunk);
    blob?.update(chunk);
    if (collect) chunks.push(chunk);
  }
  if (gitSha) {
    requireValue(bytes === limit, "Upstream file size does not match its Git tree.");
    requireValue(blob.digest("hex") === gitSha, "Upstream file does not match its Git blob.");
  }
  return { bytes, sha256: sha256.digest("hex"), data: collect ? Buffer.concat(chunks) : undefined };
}

async function api(endpoint) {
  const headers = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const result = await read(`https://api.github.com/repos/${repository}/${endpoint}`, {
    headers,
    limit: 16 * 1024 * 1024,
  });
  return JSON.parse(result.data.toString("utf8"));
}

function properties(text) {
  const result = new Map();
  for (const row of text.trim().split(/\r?\n/)) {
    const separator = row.indexOf("=");
    requireValue(separator > 0, "Upstream manifest has an invalid property.");
    const key = row.slice(0, separator);
    requireValue(!result.has(key), "Upstream manifest has duplicate properties.");
    result.set(key, row.slice(separator + 1));
  }
  return result;
}

function checksums(text) {
  const result = new Map();
  for (const row of text.trim().split(/\r?\n/)) {
    const match = /^([a-f0-9]{64}) [ *]([a-zA-Z0-9][a-zA-Z0-9.+_-]*)$/.exec(row);
    requireValue(match && !result.has(match[2]), "Upstream SHA256SUMS is malformed or duplicated.");
    result.set(match[2], match[1]);
  }
  return result;
}

function literal(value) {
  const lines = JSON.stringify(value, null, 2)
    .replace(/^(\s*)"([a-zA-Z]\w*)":/gm, "$1$2:")
    .split("\n");
  return lines
    .map((line, index) => {
      const next = lines[index + 1]?.trim();
      return next && /^[}\]]/.test(next) && !/[{[,\s]$/.test(line) ? `${line},` : line;
    })
    .join("\n");
}

async function atomicWrite(filename, bytes) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, bytes, { flag: "wx" });
    await fs.rename(temporary, filename);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function main() {
  let ref = "FHS-D";
  let receiptPath;
  let check = false;
  for (let index = 2; index < process.argv.length; index++) {
    const flag = process.argv[index];
    if (flag === "--check") check = true;
    else if ((flag === "--ref" || flag === "--receipt") && process.argv[index + 1]) {
      const value = process.argv[++index];
      if (flag === "--ref") ref = value;
      else receiptPath = path.resolve(value);
    } else
      throw new SyncError(
        "Usage: node scripts/sync-native.mjs [--ref FHS-D|commit] [--receipt path] [--check]",
      );
  }
  requireValue(
    ref.length > 0 && ref.length <= 255 && !ref.startsWith("--"),
    "Invalid upstream ref.",
  );
  requireValue(receiptPath !== output, "The receipt must not replace generated source.");
  // This is the only moving-ref lookup. Every later API request and raw URL uses its immutable SHA.
  const commit = await api(`commits/${encodeURIComponent(ref)}`);
  const distributionCommit = commit.sha;
  requireValue(
    commitPattern.test(distributionCommit) && commitPattern.test(commit.commit?.tree?.sha),
    "GitHub did not resolve an immutable commit and tree.",
  );
  if (/^[a-fA-F0-9]{40}$/.test(ref))
    requireValue(distributionCommit === ref.toLowerCase(), "GitHub resolved a different commit.");
  const tree = await api(`git/trees/${commit.commit.tree.sha}?recursive=1`);
  requireValue(
    tree.truncated === false && Array.isArray(tree.tree),
    "Upstream Git tree is incomplete.",
  );
  const entries = new Map(tree.tree.map((entry) => [entry.path, entry]));
  const entry = (filename) => {
    const value = entries.get(filename);
    requireValue(
      value?.type === "blob" &&
        ["100644", "100755"].includes(value.mode) &&
        commitPattern.test(value.sha) &&
        Number.isSafeInteger(value.size) &&
        value.size > 0,
      `Upstream file is missing or not regular: ${filename}.`,
    );
    return value;
  };
  const fetchFile = async (filename, collect) => {
    const file = entry(filename);
    if (collect)
      requireValue(file.size <= 1024 * 1024, "Upstream provenance is unexpectedly large.");
    return await read(
      `https://raw.githubusercontent.com/${repository}/${distributionCommit}/${filename}`,
      {
        limit: file.size,
        collect,
        gitSha: file.sha,
      },
    );
  };

  const artifacts = {};
  const plans = [];
  let sourceCommit;
  for (const target of targets) {
    const prefix = `build/provenance/${target}`;
    const metadata = new Map();
    for (const name of records) metadata.set(name, await fetchFile(`${prefix}/${name}`, true));
    const manifest = properties(metadata.get("manifest.txt").data.toString("utf8"));
    const sums = checksums(metadata.get("SHA256SUMS").data.toString("utf8"));
    const binary = target === "windows-amd64" ? "cypher.exe" : `cypher-${target}`;
    const [goos, goarch] = target.split("-");
    const declaredSource = manifest.get("source_sha");
    requireValue(
      commitPattern.test(declaredSource) && (!sourceCommit || sourceCommit === declaredSource),
      "Upstream targets do not share one valid source commit.",
    );
    sourceCommit = declaredSource;
    requireValue(
      manifest.get("goos") === goos &&
        manifest.get("goarch") === goarch &&
        manifest.get("binary") === binary,
      `Upstream manifest target disagrees: ${target}.`,
    );
    requireValue(
      manifest.get("ipc_transaction_finality_method") === "eth_getTransactionFinality" &&
        manifest.get("ipc_transaction_finality_transport") === "ipc",
      `Upstream IPC transaction-finality contract is incompatible: ${target}.`,
    );
    const buildInfo = metadata
      .get("go-build-info.txt")
      .data.toString("utf8")
      .replaceAll("\r\n", "\n");
    requireValue(
      buildInfo.includes(`\tbuild\tGOOS=${goos}\n`) &&
        buildInfo.includes(`\tbuild\tGOARCH=${goarch}\n`),
      `Upstream Go build target disagrees: ${target}.`,
    );
    const payload = [binary];
    if (target === "windows-amd64") {
      payload.push(
        ...tree.tree
          .filter((file) => /^build\/bin\/[^/]+\.dll$/i.test(file.path))
          .map((file) => path.posix.basename(file.path))
          .sort(),
      );
    }
    requireValue(
      payload.every((name) => namePattern.test(name)),
      "Upstream native filename is invalid.",
    );
    const allowed = new Set([
      ...payload,
      "manifest.txt",
      "go-build-info.txt",
      ...(target === "linux-amd64" ? ["cypher"] : []),
    ]);
    requireValue(
      [...sums.keys()].every((name) => allowed.has(name)) &&
        [...payload, "manifest.txt", "go-build-info.txt"].every((name) => sums.has(name)),
      `Upstream checksum inventory is incomplete or inconsistent: ${target}.`,
    );
    for (const name of ["manifest.txt", "go-build-info.txt"])
      requireValue(
        metadata.get(name).sha256 === sums.get(name),
        `Upstream provenance digest disagrees: ${target}/${name}.`,
      );
    requireValue(
      manifest.get("binary_sha256") === sums.get(binary),
      `Upstream manifest binary digest disagrees: ${target}.`,
    );
    plans.push({ target, prefix, binary, payload, sums, metadata });
  }
  const comparison = await api(`compare/${sourceCommit}...${distributionCommit}`);
  const buildPath = (filename) =>
    typeof filename === "string" &&
    (filename.startsWith("build/bin/") || filename.startsWith("build/provenance/"));
  requireValue(
    ["ahead", "identical"].includes(comparison.status) &&
      comparison.merge_base_commit?.sha === sourceCommit &&
      comparison.behind_by === 0 &&
      Array.isArray(comparison.files) &&
      comparison.files.length < 300 &&
      comparison.files.every(
        (file) =>
          buildPath(file.filename) &&
          (!file.previous_filename || buildPath(file.previous_filename)),
      ),
    "Upstream source changed after its native build, or ancestry evidence is incomplete. Publish a complete three-OS native build first.",
  );
  for (const { target, prefix, binary, payload, sums, metadata } of plans) {
    const selected = [];
    for (const name of payload) {
      const filename = `build/bin/${name}`;
      const downloaded = await fetchFile(filename, false);
      requireValue(
        downloaded.sha256 === sums.get(name),
        `Upstream native digest disagrees: ${target}/${name}.`,
      );
      selected.push({
        path: filename,
        bytes: downloaded.bytes,
        sha256: downloaded.sha256,
        executable: name === binary,
      });
    }
    for (const name of records) {
      const file = metadata.get(name);
      selected.push({
        path: `${prefix}/${name}`,
        bytes: file.bytes,
        sha256: file.sha256,
        executable: false,
      });
    }
    artifacts[target] = selected;
  }
  const pin = { repository, distributionCommit, sourceCommit };
  const generated = `// Generated by scripts/sync-native.mjs; do not edit.\nimport type { NativeArtifact, NativePin, NativeTarget } from "./types.js";\n\nexport const NODE_PIN: NativePin = ${literal(pin)};\n\nexport const NODE_ARTIFACTS: Partial<Record<NativeTarget, readonly NativeArtifact[]>> = ${literal(artifacts)};\n`;
  if (check)
    requireValue(
      (await fs.readFile(output, "utf8")) === generated,
      "Generated node pins differ. Run node scripts/sync-native.mjs to refresh them.",
    );
  else await atomicWrite(output, generated);
  const receipt = { formatVersion: 1, requestedRef: ref, ...pin, targets: artifacts };
  if (receiptPath) await atomicWrite(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(
    JSON.stringify({
      repository,
      distributionCommit,
      sourceCommit,
      generated: "src/native/node-pins.ts",
      checked: check,
      artifacts: Object.values(artifacts).reduce((count, files) => count + files.length, 0),
    }),
  );
}

main().catch((error) => {
  // Upstream transport exceptions can include request metadata; never expose credentials.
  console.error(
    error instanceof SyncError
      ? error.message
      : "Native synchronization failed. Check upstream network access and provenance.",
  );
  process.exitCode = 1;
});
