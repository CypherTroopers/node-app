import type { NativeArtifact, NativePin, NativeTarget } from "./types.js";

export { NODE_PIN, NODE_ARTIFACTS } from "./node-pins.js";

// The retained release metadata identifies the historical source. The available
// distribution has identical executable bytes but rewrote its build-info files.
export const WALLET_PIN: NativePin = {
  repository: "CypherTroopers/offlinewalletgenerator",
  distributionCommit: "629b3122aab207a7d7149439101c571a3360eecf",
  sourceCommit: "8879d9e4c0490999096bb299a0e2da31a1b20e50",
};

const file = (path: string, bytes: number, sha256: string, executable = false): NativeArtifact => ({
  path,
  bytes,
  sha256,
  executable,
});

export const WALLET_ARTIFACTS: Record<NativeTarget, readonly NativeArtifact[]> = {
  "linux-amd64": [
    file(
      "bin/linux-amd64/coldwalletgenerator",
      5375467,
      "a4c7183c2400f713563eea275e744fd90e840f5def3fd9f5790bea9bfbdbdd76",
      true,
    ),
  ],
  "linux-arm64": [
    file(
      "bin/linux-arm64/coldwalletgenerator",
      5080948,
      "c1e2c8d4a43eb479173d975d10b18f979c85a227cd3ceb9581a8666405670d41",
      true,
    ),
  ],
  "darwin-amd64": [
    file(
      "bin/darwin-amd64/coldwalletgenerator",
      5458832,
      "c9f1abc05bd5988486350777c403d1404b5bccd6990369c4c97cbf4e5f5ebb92",
      true,
    ),
  ],
  "darwin-arm64": [
    file(
      "bin/darwin-arm64/coldwalletgenerator",
      5174898,
      "ab12b2aa31e4d07a5e9a130a24f1df0c4a275518d74d29f9bb35a80b998411f0",
      true,
    ),
  ],
  "windows-amd64": [
    file(
      "bin/windows-amd64/coldwalletgenerator.exe",
      5442560,
      "3f5253dfd8d82a1c98b02a6e96a18b6abfbb61fcc34c92c427dd95d41c18a5c2",
      true,
    ),
  ],
  "windows-arm64": [
    file(
      "bin/windows-arm64/coldwalletgenerator.exe",
      5037056,
      "fc9423112440eb44221491988601f33d01dd1a24632197f3b4a6f5872b98fe05",
      true,
    ),
  ],
};

export function resolveNativeTarget(platform: string, arch: string): NativeTarget | null {
  const os = platform === "win32" ? "windows" : platform;
  const cpu = arch === "x64" ? "amd64" : arch;
  const target = `${os}-${cpu}`;
  switch (target) {
    case "linux-amd64":
    case "linux-arm64":
    case "darwin-amd64":
    case "darwin-arm64":
    case "windows-amd64":
    case "windows-arm64":
      return target;
    default:
      return null;
  }
}
