#!/bin/bash
set -uo pipefail

root=$(cd "$(dirname "$0")/.." && pwd) || exit 1
output=${DIAGNOSTICS_DIR:?Set DIAGNOSTICS_DIR to a new evidence directory.}
mkdir "$output" || exit 1
scratch=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/colossusx-macos-check.XXXXXX") || exit 1
mountpoint="$scratch/mount"
dmg="$scratch/original.dmg"
url=https://github.com/CypherTroopers/node-app/releases/download/v0.1.0/ColossusX-Node-Manager-0.1.0-mac-arm64.dmg
expected=3bf593d0f98414bd2726c4d541da913c61f7887649753221fb008faae6f044ed
failed=0
mounted=0
printf 'check\texit_status\n' > "$output/status.tsv"

sanitize() {
  python3 -c '
import os, re, sys
text = sys.stdin.read()
text = re.sub(r"(?i)(#token=|[?&]token=)[^\s\"<>]+", r"\1[REDACTED]", text)
text = re.sub(r"(?i)(cypher_session=)[^\s;\"<>]+", r"\1[REDACTED]", text)
for key in ("GITHUB_WORKSPACE", "RUNNER_TEMP", "HOME"):
    value = os.environ.get(key)
    if value:
        text = text.replace(value, "[" + key + "]")
sys.stdout.write(text)
'
}

record() {
  local label=$1 status
  shift
  if "$@" > "$scratch/$label.raw" 2>&1; then status=0; else status=$?; fi
  sanitize < "$scratch/$label.raw" > "$output/$label.log"
  printf '%s\t%s\n' "$label" "$status" >> "$output/status.tsv"
  if [ "$status" -ne 0 ]; then failed=1; fi
  return "$status"
}

unavailable() {
  printf '%s\n' "$3" > "$output/$1.log"
  printf '%s\t%s\n' "$1" "$2" >> "$output/status.tsv"
}

finish() {
  local status=$?
  trap - EXIT
  if [ "$mounted" -eq 1 ]; then
    if record detach hdiutil detach "$mountpoint"; then mounted=0; else status=1; fi
  fi
  {
    printf 'Released macOS v0.1.0 diagnostic\n\n'
    printf 'Asset: %s\nExpected SHA256: %s\nDiagnostic source: %s\n\n' "$url" "$expected" "${GITHUB_SHA:-local}"
    printf 'The downloaded DMG and mounted application were not modified. No signing, notarization, quarantine removal, or Gatekeeper setting changes were performed.\n\n'
    printf 'curl does not reproduce Chrome download quarantine metadata. Direct Playwright execution checks the packaged runtime separately from Gatekeeper acceptance. A runner GUI/automation failure alone does not establish a product defect. The existing desktop proof also checks its packaged worker and navigation boundaries.\n\n'
    printf '| Check | Exit status |\n| --- | --- |\n'
    while IFS=$'\t' read -r check result; do
      [ "$check" = check ] || printf '| %s | %s |\n' "$check" "$result"
    done < "$output/status.tsv"
    printf '\nNonzero command statuses are retained as failures; unavailable optional tools are labeled. See the individual sanitized logs.\n'
  } > "$output/summary.md"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then cat "$output/summary.md" >> "$GITHUB_STEP_SUMMARY"; fi
  if [ "$mounted" -eq 0 ]; then rm -rf "$scratch"; fi
  if [ "$failed" -ne 0 ]; then status=1; fi
  exit "$status"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

record system sw_vers || true
record architecture uname -m || exit 1
if [ "$(cat "$scratch/architecture.raw")" != arm64 ]; then
  unavailable arm64-required 1 'This diagnostic requires an Apple silicon runner.'
  exit 1
fi
record download curl --fail --location --silent --show-error --connect-timeout 30 --max-time 180 --output "$dmg" "$url" || exit 1
record sha256 shasum -a 256 "$dmg" || exit 1
read -r actual _ < "$scratch/sha256.raw"
if [ "$actual" != "$expected" ]; then
  unavailable expected-sha256 1 'The asset hash differs from the original published DMG. Mounting and execution were refused.'
  exit 1
fi
unavailable expected-sha256 0 'The complete original published DMG hash matches.'
record dmg-xattrs xattr -l "$dmg" || true
record dmg-verify hdiutil verify "$dmg" || exit 1
mkdir "$mountpoint" || exit 1
mounted=1
record attach hdiutil attach -readonly -nobrowse -mountpoint "$mountpoint" "$dmg" || exit 1
apps=("$mountpoint"/*.app)
if [ "${#apps[@]}" -ne 1 ] || [ ! -d "${apps[0]}" ]; then
  unavailable application-bundle 1 'Expected exactly one top-level application bundle in the DMG.'
  exit 1
fi
app=${apps[0]}
record app-xattrs xattr -l "$app" || true
record signature-display codesign --display --verbose=4 "$app" || true
record entitlements codesign --display --entitlements :- "$app" || true
record signature-verify codesign --verify --deep --strict --verbose=4 "$app" || true
record gatekeeper spctl --assess --type execute --verbose=4 "$app" || true
if command -v syspolicy_check > /dev/null 2>&1; then
  record distribution-policy syspolicy_check distribution "$app" || true
else
  unavailable distribution-policy unavailable 'syspolicy_check is unavailable on this runner.'
fi
record bundle-executable /usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app/Contents/Info.plist" || exit 1
IFS= read -r executable_name < "$scratch/bundle-executable.raw"
case "$executable_name" in
  ''|.|..|*/*) unavailable executable-path 1 'Invalid bundle executable name.'; exit 1 ;;
esac
executable="$app/Contents/MacOS/$executable_name"
if [ ! -x "$executable" ]; then
  unavailable executable-path 1 'The bundle executable is missing or not executable.'
  exit 1
fi
printf '%s\n' "$executable" | sanitize > "$output/executable.txt"
if [ "${DIAGNOSTIC_DEPENDENCIES_READY:-false}" != true ]; then
  unavailable desktop-proof 125 'Not run: frozen diagnostic dependency installation did not succeed.'
  exit 1
fi

before=("$root"/artifacts/proof/desktop-*)
export DIAGNOSTIC_APP_EXECUTABLE="$executable" DIAGNOSTIC_APP_ROOT="$root"
run_gui() {
  node --input-type=module <<'NODE'
import { spawn } from "node:child_process";
const child = spawn(process.execPath, ["desktop/proof.mjs", process.env.DIAGNOSTIC_APP_EXECUTABLE], {
  cwd: process.env.DIAGNOSTIC_APP_ROOT,
  detached: true,
  stdio: "inherit",
});
let timedOut = false;
let interrupted = false;
let force;
function signalGroup(signal) {
  if (!child.pid) return false;
  try { process.kill(-child.pid, signal); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}
function stop() {
  if (signalGroup("SIGTERM") && !force) force = setTimeout(() => signalGroup("SIGKILL"), 5_000);
}
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { interrupted = true; stop(); });
const timeout = setTimeout(() => { timedOut = true; console.error("Packaged desktop proof exceeded 120 seconds."); stop(); }, 120_000);
const result = await new Promise((resolve) => {
  child.once("error", (error) => { console.error(error.message); resolve({ code: 1 }); });
  child.once("close", (code, signal) => resolve({ code, signal }));
});
clearTimeout(timeout);
stop();
process.exitCode = timedOut ? 124 : interrupted ? 143 : result.code ?? 1;
NODE
}
record desktop-proof run_gui || true
for directory in "$root"/artifacts/proof/desktop-*; do
  owned=1
  for existing in "${before[@]}"; do
    if [ "$directory" = "$existing" ]; then owned=0; break; fi
  done
  if [ "$owned" -eq 1 ] && [ -d "$directory" ]; then
    if [ -f "$directory/report.json" ]; then sanitize < "$directory/report.json" > "$output/desktop-report.json"; fi
    if [ -f "$directory/packaged-node.png" ]; then cp "$directory/packaged-node.png" "$output/packaged-node.png"; fi
    rm -rf "$directory"
  fi
done
