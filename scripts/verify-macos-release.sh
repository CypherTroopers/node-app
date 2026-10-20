#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != Darwin || "$(uname -m)" != arm64 ]]; then
  printf 'Verify the macOS release on an Apple silicon Mac.\n' >&2
  exit 1
fi
if [[ -z "${APPLE_TEAM_ID:-}" ]]; then
  printf 'APPLE_TEAM_ID is required to verify the macOS release signing team.\n' >&2
  exit 1
fi

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
shopt -s nullglob
images=("$root"/release/*.dmg)
if (( ${#images[@]} != 1 )); then
  printf 'Expected exactly one finished macOS release DMG.\n' >&2
  exit 1
fi

hdiutil verify "${images[0]}"
verification_dir="$(mktemp -d "${TMPDIR:-/tmp}/cypher-macos-release.XXXXXX")"
mount_path="$verification_dir/mount"
mounted=false
cleanup() {
  local result=$?
  if [[ "$mounted" == true ]] && ! hdiutil detach "$mount_path"; then
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
hdiutil attach -readonly -nobrowse -mountpoint "$mount_path" "${images[0]}"

apps=("$mount_path"/*.app)
if (( ${#apps[@]} != 1 )); then
  printf 'Expected exactly one application in the finished macOS release DMG.\n' >&2
  exit 1
fi
app="${apps[0]}"
executable_name="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app/Contents/Info.plist")"
executable="$app/Contents/MacOS/$executable_name"
if [[ "$(lipo -archs "$executable")" != arm64 ]]; then
  printf 'The macOS release executable must contain only ARM64 code.\n' >&2
  exit 1
fi

codesign --verify --deep --strict --verbose=4 "$app"
codesign --display --verbose=4 "$app" 2>&1 | tee "$verification_dir/signature.txt"
if ! grep -q '^Authority=Developer ID Application:' "$verification_dir/signature.txt"; then
  printf 'The macOS release must be signed with a Developer ID Application certificate.\n' >&2
  exit 1
fi
if ! grep -Fqx "TeamIdentifier=$APPLE_TEAM_ID" "$verification_dir/signature.txt"; then
  printf 'The macOS release signing team does not match APPLE_TEAM_ID.\n' >&2
  exit 1
fi
xcrun stapler validate "$app"
spctl --assess --type execute --verbose=4 "$app"
syspolicy_check distribution "$app"
node "$root/desktop/proof.mjs" "$executable"
