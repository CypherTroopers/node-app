#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

if [[ "$(uname -s)" != Darwin || "$(uname -m)" != arm64 ]]; then
  printf 'Verify the macOS release on an Apple silicon Mac.\n' >&2
  exit 1
fi
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
shopt -s nullglob
images=("$root"/release/*.dmg)
if (( ${#images[@]} != 1 )); then
  printf 'Expected exactly one finished macOS release DMG.\n' >&2
  exit 1
fi

output="$root/artifacts/macos-release-verification"
mkdir -p "$root/artifacts"
mkdir "$output"
printf 'check\texit_status\n' > "$output/status.tsv"
record() {
  local label=$1 result
  shift
  if "$@" > "$output/$label.log" 2>&1; then result=0; else result=$?; fi
  cat "$output/$label.log"
  printf '%s\t%s\n' "$label" "$result" >> "$output/status.tsv"
  return "$result"
}

record dmg-verify hdiutil verify "${images[0]}"
verification_dir="$(mktemp -d "${TMPDIR:-/tmp}/cypher-macos-release.XXXXXX")"
mount_path="$verification_dir/mount"
mounted=false
cleanup() {
  local result=$?
  if [[ "$mounted" == true ]] && ! record detach hdiutil detach "$mount_path"; then
    printf 'Failed to detach the verification image at %s.\n' "$mount_path" >&2
    exit 1
  fi
  rm -rf "$verification_dir"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir "$mount_path"
mounted=true
record attach hdiutil attach -readonly -nobrowse -mountpoint "$mount_path" "${images[0]}"

apps=("$mount_path"/*.app)
if (( ${#apps[@]} != 1 )); then
  printf 'Expected exactly one application in the finished macOS release DMG.\n' >&2
  exit 1
fi
app="${apps[0]}"
executable_name="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app/Contents/Info.plist")"
case "$executable_name" in
  ''|.|..|*/*) printf 'Invalid application bundle executable name.\n' >&2; exit 1 ;;
esac
executable="$app/Contents/MacOS/$executable_name"
if [[ "$(lipo -archs "$executable")" != arm64 ]]; then
  printf 'The macOS release executable must contain only ARM64 code.\n' >&2
  exit 1
fi

record signature-verify codesign --verify --deep --strict --verbose=4 "$app"
record signature-display codesign --display --verbose=4 "$app"
if ! grep -Fqx 'Identifier=ai.cyphertroopers.colossusx-node-manager' "$output/signature-display.log" ||
   ! grep -Fqx 'Signature=adhoc' "$output/signature-display.log" ||
   ! grep -q '^Info.plist entries=' "$output/signature-display.log" ||
   ! grep -q '^Sealed Resources version=' "$output/signature-display.log"; then
  printf 'The macOS release requires its own ad-hoc signature, bound Info.plist, and sealed resources.\n' >&2
  exit 1
fi
record gatekeeper spctl --assess --type execute --verbose=4 "$app" || true
record distribution-policy syspolicy_check distribution "$app" || true
record desktop-proof node "$root/desktop/proof.mjs" "$executable"

node --input-type=module - "$output" "$app" <<'NODE'
import fs from "node:fs/promises";
import path from "node:path";
const [output, app] = process.argv.slice(2);
const read = (name) => fs.readFile(path.join(output, name), "utf8");
const checks = Object.fromEntries((await read("status.tsv")).trim().split("\n").slice(1).map((line) => {
  const [name, status] = line.split("\t");
  return [name, Number(status)];
}));
const gatekeeper = (await read("gatekeeper.log")).trim();
const expectedGatekeeper = checks.gatekeeper === 3 && gatekeeper === `${app}: rejected\nsource=no usable signature`;
const distribution = (await read("distribution-policy.log")).split("\n").filter((line) => /^\S/.test(line) && !/^-+$/.test(line));
const [summary, ...issues] = distribution;
const expectedDistribution = [65, 70].includes(checks["distribution-policy"]) &&
  summary === "App has failed one or more pre-distribution checks." &&
  issues.includes("Notary Ticket Missing") &&
  issues.every((issue) => issue === "Notary Ticket Missing" || issue === "Adhoc Signed App");
const status = {
  signing: "adhoc",
  integrity: "verified",
  notarization: "not-notarized",
  gatekeeper: { result: expectedGatekeeper ? "rejected-no-usable-signature" : "unexpected", exitStatus: checks.gatekeeper },
  distributionPolicy: { result: expectedDistribution ? "rejected-unnotarized" : "unexpected", exitStatus: checks["distribution-policy"], issues },
  packagedGui: { entryPoint: "direct-playwright-executable", result: "passed" },
  checks,
};
await fs.writeFile(path.join(output, "status.json"), `${JSON.stringify(status, null, 2)}\n`);
console.log(JSON.stringify(status, null, 2));
if (!expectedGatekeeper || !expectedDistribution) {
  throw new Error("Unexpected macOS policy assessment. Inspect the retained policy logs before releasing.");
}
console.log("Ad-hoc bundle integrity and packaged GUI verified. Gatekeeper rejects this unnotarized release; browser/Finder admission remains unverified.");
NODE
