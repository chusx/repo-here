#!/usr/bin/env bash
# Build the distributable Term Here files into dist/ (from committed files only):
#   term-here.crx  signed extension, same ID as the unpacked one (ipldffceopngiolfclkimmjkbgapjnfp)
#   term-here.zip  term-here/{extension,host,install.sh,README.md}: Load unpacked + native hosts
#   updates.xml    update manifest for .crx installs (served next to the .crx)
#
# usage: ./package.sh [key.pem]    default key: ~/.config/term-here/extension-key.pem
# The key must match the "key" in extension/manifest.json; keep it private and out of git.
set -euo pipefail
cd "$(dirname "$0")"

KEY="${1:-$HOME/.config/term-here/extension-key.pem}"
CHROME="${CHROME:-$(command -v google-chrome || command -v chromium || command -v chromium-browser || true)}"
[[ -f "$KEY" ]] || { echo "signing key not found: $KEY" >&2; exit 1; }
[[ -x "$CHROME" ]] || { echo "Chrome/Chromium not found (set CHROME=...)" >&2; exit 1; }
git diff --quiet HEAD -- extension host install.sh || echo "warning: uncommitted changes are NOT packaged" >&2

read -r VERSION UPDATE_URL < <(python3 -c 'import json; m = json.load(open("extension/manifest.json")); print(m["version"], m.get("update_url", ""))')
EXT_ID=ipldffceopngiolfclkimmjkbgapjnfp
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/term-here" dist
git archive HEAD extension host install.sh README.md | tar -x -C "$TMP/term-here"

"$CHROME" --headless=new --no-sandbox --user-data-dir="$TMP/profile" \
  --pack-extension="$TMP/term-here/extension" --pack-extension-key="$KEY" >/dev/null 2>&1
mv "$TMP/term-here/extension.crx" dist/term-here.crx
rm -f dist/term-here.zip
(cd "$TMP" && zip -qr -X "$OLDPWD/dist/term-here.zip" term-here)

cat > dist/updates.xml <<XML
<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
  <app appid='$EXT_ID'>
    <updatecheck codebase='${UPDATE_URL%/*}/term-here.crx' version='$VERSION' />
  </app>
</gupdate>
XML

ls -la dist
