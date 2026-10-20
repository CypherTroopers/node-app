#!/bin/bash
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
  if "$@" > "$output/$label.log" 2> "$output/$label.stderr.log"; then result=0; else result=$?; fi
  cat "$output/$label.log"
  cat "$output/$label.stderr.log" >&2
  printf '%s\t%s\n' "$label" "$result" >> "$output/status.tsv"
  return "$result"
}

record dmg-verify hdiutil verify "${images[0]}"
verification_dir="$(mktemp -d "${TMPDIR:-/tmp}/cypher-macos-release.XXXXXX")"
verification_dir="$(cd "$verification_dir" && pwd -P)"
mount_path="$verification_dir/mount"
mounted=false
cleanup() {
  local result=$?
  trap - EXIT
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
if ! grep -Fqx 'Identifier=ai.cyphertroopers.colossusx-node-manager' "$output/signature-display.stderr.log" ||
   ! grep -Fqx 'Signature=adhoc' "$output/signature-display.stderr.log" ||
   ! grep -q '^Info.plist entries=' "$output/signature-display.stderr.log" ||
   ! grep -q '^Sealed Resources version=' "$output/signature-display.stderr.log" ||
   ! grep -q '^CodeDirectory .*flags=.*runtime' "$output/signature-display.stderr.log"; then
  printf 'The macOS release requires its own ad-hoc signature, bound Info.plist, and sealed resources.\n' >&2
  exit 1
fi

# Apple policy tools can return an internal error for even a fresh empty ad-hoc app.
# Compare on this host, retain the rejection, and never interpret that error as a clean scan.
control="$verification_dir/HarmlessAdhoc.app"
mkdir -p "$control/Contents/MacOS"
printf 'int main(void) { return 0; }\n' > "$verification_dir/harmless.c"
cat > "$control/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>ai.cyphertroopers.policy-control</string>
<key>CFBundleName</key><string>Harmless Adhoc Control</string>
<key>CFBundleExecutable</key><string>harmless</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleShortVersionString</key><string>1.0</string>
</dict></plist>
PLIST
record control-compile xcrun clang -arch arm64 "$verification_dir/harmless.c" -o "$control/Contents/MacOS/harmless"
record control-sign codesign --force --sign - --options runtime "$control"
record control-signature codesign --verify --deep --strict --verbose=4 "$control"
trusted='/Applications/Google Chrome.app'
record trusted-signature codesign --verify --deep --strict --verbose=4 "$trusted"
record gatekeeper-status spctl --status

assess() {
  local label=$1 assessed_app=$2
  record "$label-gatekeeper" spctl --assess --type execute --verbose=4 --raw "$assessed_app" || true
  record "$label-gatekeeper-json" plutil -convert json -o "$output/$label-gatekeeper.json" "$output/$label-gatekeeper.log"
  record "$label-policy" syspolicy_check distribution "$assessed_app" --json || true
}
assess candidate "$app"
assess control "$control"
assess trusted "$trusted"
record desktop-proof node "$root/desktop/proof.mjs" "$executable"

node --input-type=module - "$output" "$app" "$control" <<'NODE'
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
const [output, app, control] = process.argv.slice(2);
const read = (name) => fs.readFile(path.join(output, name), "utf8");
const checks = Object.fromEntries((await read("status.tsv")).trim().split("\n").slice(1).map((line) => {
  const [name, status] = line.split("\t");
  return [name, Number(status)];
}));
assert.equal((await read("gatekeeper-status.log")).trim(), "assessments enabled");
const expectedRejection = {
  "assessment:authority": { "assessment:authority:flags": 0 },
  "assessment:remote": true,
  "assessment:verdict": false,
};
const policy = {};
for (const [label, assessedApp] of [["candidate", app], ["control", control]]) {
  assert.equal(checks[`${label}-gatekeeper`], 3, `${label}: unexpected Gatekeeper status`);
  assert.deepEqual(JSON.parse(await read(`${label}-gatekeeper.json`)), expectedRejection);
  assert.equal((await read(`${label}-gatekeeper.stderr.log`)).trim(), `${assessedApp}: rejected`);
  assert.equal(checks[`${label}-policy`], 70, `${label}: unexpected policy status`);
  assert.equal((await read(`${label}-policy.stderr.log`)).trim(), "");
  const result = JSON.parse(await read(`${label}-policy.log`));
  assert.deepEqual(Object.keys(result), ["output"]);
  assert.ok(Array.isArray(result.output) && [1, 2].includes(result.output.length));
  const normalized = result.output.map((issue) => {
    const missingTicket = issue.SyspolicyCheckShortError === "Notary Ticket Missing";
    const internalError = issue.SyspolicyCheckShortError === "Internal Xprotect Error";
    assert.ok(missingTicket || internalError, `${label}: unknown policy issue`);
    assert.deepEqual(Object.keys(issue).sort(), [
      "SyspolicyCheckAdditionalInformation", "SyspolicyCheckAdvice", "SyspolicyCheckDocumentationLink",
      "SyspolicyCheckErrorLevel", "SyspolicyCheckLongError", "SyspolicyCheckShortError",
      ...(missingTicket ? ["SyspolicyCheckErrorFile"] : []),
    ].sort());
    assert.equal(issue.SyspolicyCheckErrorLevel, "Fatal");
    assert.equal(issue.SyspolicyCheckAdditionalInformation, "");
    assert.equal(issue.SyspolicyCheckLongError, missingTicket
      ? "A Notarization ticket is not stapled to this application."
      : "One or more files in your application triggered an Xprotect error.");
    if (missingTicket) {
      assert.equal(issue.SyspolicyCheckErrorFile, assessedApp);
      return { ...issue, SyspolicyCheckErrorFile: "<assessed-app>" };
    }
    return issue;
  }).sort((a, b) => a.SyspolicyCheckShortError.localeCompare(b.SyspolicyCheckShortError));
  const titles = normalized.map((issue) => issue.SyspolicyCheckShortError);
  assert.ok(titles.includes("Notary Ticket Missing") && new Set(titles).size === titles.length);
  policy[label] = normalized;
}
assert.deepEqual(policy.candidate, policy.control, "Candidate policy differs from the fresh harmless control");
assert.equal(checks["trusted-gatekeeper"], 0);
assert.equal(checks["trusted-policy"], 0);
assert.equal((await read("trusted-policy.stderr.log")).trim(), "");
assert.deepEqual(JSON.parse(await read("trusted-policy.log")), { output: [] });
const trustedAssessment = JSON.parse(await read("trusted-gatekeeper.json"));
assert.equal(trustedAssessment["assessment:verdict"], true);
assert.equal(trustedAssessment["assessment:authority"]?.["assessment:authority:source"], "Notarized Developer ID");
const issues = policy.candidate.map((issue) => issue.SyspolicyCheckShortError);
const status = {
  signing: "adhoc",
  integrity: "verified",
  notarization: "not-notarized",
  gatekeeper: { result: "rejected", exitStatus: checks["candidate-gatekeeper"] },
  distributionPolicy: { result: "rejected-unnotarized-matches-control", exitStatus: checks["candidate-policy"], issues },
  xprotect: issues.includes("Internal Xprotect Error") ? "inconclusive-tool-error-matches-control" : "not-established",
  controls: { harmlessAdhoc: "matched", trustedChrome: "accepted" },
  packagedGui: { entryPoint: "direct-playwright-executable", result: "passed" },
  checks,
};
await fs.writeFile(path.join(output, "status.json"), `${JSON.stringify(status, null, 2)}\n`);
console.log(JSON.stringify(status, null, 2));
console.log("Ad-hoc bundle integrity and packaged GUI verified. Gatekeeper rejects this unnotarized release; browser/Finder admission remains unverified.");
NODE
