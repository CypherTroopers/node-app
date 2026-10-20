#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

if [[ "$(uname -s)" != Darwin || "$(uname -m)" != arm64 ]]; then
  printf 'Run this diagnostic on an Apple silicon Mac.\n' >&2
  exit 1
fi
candidate=$(cd "${1:?Pass the isolated candidate source directory.}" && pwd)
output=${DIAGNOSTICS_DIR:?Set DIAGNOSTICS_DIR to a new diagnostic directory.}
mkdir "$output"
scratch=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/macos-policy-controls.XXXXXX")
mount_path="$scratch/mount"
mounted=false
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
  local label=$1 result
  shift
  if "$@" > "$scratch/$label.stdout" 2> "$scratch/$label.stderr"; then result=0; else result=$?; fi
  sanitize < "$scratch/$label.stdout" > "$output/$label.stdout.txt"
  sanitize < "$scratch/$label.stderr" > "$output/$label.stderr.txt"
  printf '%s\t%s\n' "$label" "$result" >> "$output/status.tsv"
  printf '%s: exit %s\n' "$label" "$result"
  return "$result"
}
cleanup() {
  local result=$?
  trap - EXIT
  if [[ "$mounted" == true ]] && ! record detach hdiutil detach "$mount_path"; then
    printf 'The diagnostic mount could not be detached: %s\n' "$mount_path" >&2
    exit 1
  fi
  rm -rf "$scratch"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

record system sw_vers
record gatekeeper-status spctl --status || true
record syspolicy-help syspolicy_check --help || true
record syspolicy-distribution-help syspolicy_check distribution --help || true
record syspolicy-man env MANPAGER=cat PAGER=cat man syspolicy_check || true
record spctl-man env MANPAGER=cat PAGER=cat man spctl || true
record xprotect-plist-receipt pkgutil --pkg-info com.apple.pkg.XProtectPlistConfigData || true
record xprotect-payload-receipt pkgutil --pkg-info com.apple.pkg.XProtectPayloads || true
for key in CFBundleShortVersionString CFBundleVersion; do
  record "xprotect-$key" /usr/libexec/PlistBuddy -c "Print :$key" /Library/Apple/System/Library/CoreServices/XProtect.bundle/Contents/Info.plist || true
done
record xprotect-rules-version /usr/libexec/PlistBuddy -c 'Print :Version' /Library/Apple/System/Library/CoreServices/XProtect.bundle/Contents/Resources/XProtect.meta.plist || true
if command -v xprotect > /dev/null 2>&1; then
  record xprotect-help xprotect help || true
  record xprotect-status xprotect status || true
  record xprotect-version xprotect version || true
fi

shopt -s nullglob
images=("$candidate"/release/*.dmg)
if (( ${#images[@]} != 1 )); then printf 'Expected one rebuilt candidate DMG.\n' >&2; exit 1; fi
record candidate-sha256 shasum -a 256 "${images[0]}"
record candidate-dmg-verify hdiutil verify "${images[0]}"
mkdir "$mount_path"
mounted=true
record candidate-attach hdiutil attach -readonly -nobrowse -mountpoint "$mount_path" "${images[0]}"
apps=("$mount_path"/*.app)
if (( ${#apps[@]} != 1 )); then printf 'Expected one candidate application.\n' >&2; exit 1; fi
mounted_app=${apps[0]}
copied_app="$scratch/copied/colossusx-node-manager.app"
mkdir "$scratch/copied"
record candidate-copy ditto "$mounted_app" "$copied_app"
electron_app="$candidate/node_modules/electron/dist/Electron.app"
node --input-type=module - "$candidate" <<'NODE'
import assert from "node:assert/strict";
import fs from "node:fs/promises";
const root = process.argv[2];
const electron = JSON.parse(await fs.readFile(`${root}/node_modules/electron/package.json`, "utf8"));
assert.equal(electron.version, "44.9.1");
NODE

minimal_app="$scratch/HarmlessAdhoc.app"
mkdir -p "$minimal_app/Contents/MacOS"
cat > "$scratch/harmless.c" <<'C'
int main(void) { return 0; }
C
cat > "$minimal_app/Contents/Info.plist" <<'PLIST'
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
record minimal-compile xcrun clang -arch arm64 "$scratch/harmless.c" -o "$minimal_app/Contents/MacOS/harmless"
record minimal-sign codesign --force --sign - --options runtime "$minimal_app"

assess() {
  local label=$1 app=$2
  record "$label-signature-verify" codesign --verify --deep --strict --verbose=4 "$app" || true
  record "$label-signature-display" codesign --display --verbose=4 "$app" || true
  record "$label-entitlements" codesign --display --entitlements :- "$app" || true
  record "$label-gatekeeper" spctl --assess --type execute --verbose=4 "$app" || true
  record "$label-gatekeeper-raw" spctl --assess --type execute --verbose=4 --raw "$app" || true
  record "$label-policy" syspolicy_check distribution "$app" || true
  record "$label-policy-verbose" syspolicy_check distribution "$app" --verbose || true
  record "$label-policy-json" syspolicy_check distribution "$app" --json || true
}
started=$(date '+%Y-%m-%d %H:%M:%S')
assess candidate-mounted "$mounted_app"
assess candidate-copied "$copied_app"
assess electron-original "$electron_app"
assess minimal-adhoc "$minimal_app"
if [[ -d '/Applications/Google Chrome.app' ]]; then
  assess trusted-chrome '/Applications/Google Chrome.app'
fi
assess system-textedit '/System/Applications/TextEdit.app'
ended=$(date '+%Y-%m-%d %H:%M:%S')
record unified-log /usr/bin/log show --start "$started" --end "$ended" --style ndjson --info --debug --predicate \
  'process == "syspolicyd" OR process == "XprotectService" OR process == "syspolicy_check" OR subsystem BEGINSWITH[c] "com.apple.xprotect" OR sender == "AppleSystemPolicy" OR process == "amfid"' || true

printf 'index\tpath\n' > "$output/macho-files.tsv"
index=0
while IFS= read -r -d '' binary; do
  if [[ "$(file -b "$binary")" == *Mach-O* ]]; then
    index=$((index + 1))
    printf '%s\t%s\n' "$index" "${binary#"$copied_app/"}" >> "$output/macho-files.tsv"
    record "macho-$index-libraries" otool -L "$binary" || true
    record "macho-$index-load-commands" otool -l "$binary" || true
  fi
done < <(find "$copied_app" -type f -print0)
printf 'Diagnostic collection completed. All command exit statuses are retained; no policy rejection is waived and no release is accepted.\n' > "$output/summary.txt"
