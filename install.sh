#!/usr/bin/env bash
# Register the Term Here native messaging hosts with Chromium-based browsers.
#
#   ./install.sh                 install for every browser found
#   ./install.sh --uninstall     remove the registration
#   ./install.sh --extension-id <id>   allow a different extension ID
#
# The default ID matches the "key" in extension/manifest.json, so loading the
# unpacked extension from any path yields the same ID.
set -euo pipefail

# name | script | description
HOSTS=(
  "com.termhere.shell|host/term_here_host.py|Term Here shell host"
  "com.termhere.fs|host/term_here_fs.py|Term Here filesystem host (host files for webshell)"
)
EXT_ID="ipldffceopngiolfclkimmjkbgapjnfp"
UNINSTALL=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --uninstall) UNINSTALL=1 ;;
    --extension-id) EXT_ID="$2"; shift ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "$(uname)" == "Darwin" ]]; then
  BASE="$HOME/Library/Application Support"
  BROWSERS=(
    "Google/Chrome" "Google/Chrome Beta" "Google/Chrome Canary" "Chromium"
    "BraveSoftware/Brave-Browser" "Microsoft Edge" "Vivaldi" "Arc/User Data"
  )
else
  BASE="${XDG_CONFIG_HOME:-$HOME/.config}"
  BROWSERS=(
    "google-chrome" "google-chrome-beta" "google-chrome-unstable" "chromium"
    "BraveSoftware/Brave-Browser" "microsoft-edge" "vivaldi"
  )
fi

if [[ $UNINSTALL -eq 0 ]]; then
  command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 1; }
  chmod +x "$REPO_DIR"/host/*.py
fi

count=0
for b in "${BROWSERS[@]}"; do
  dir="$BASE/$b"
  [[ -d "$dir" ]] || continue
  count=$((count+1))
  for spec in "${HOSTS[@]}"; do
    IFS='|' read -r name script desc <<< "$spec"
    target="$dir/NativeMessagingHosts/$name.json"
    if [[ $UNINSTALL -eq 1 ]]; then
      if [[ -f "$target" ]]; then rm -f "$target"; echo "removed   $target"; fi
      continue
    fi
    mkdir -p "$dir/NativeMessagingHosts"
    printf '{\n  "name": "%s",\n  "description": "%s",\n  "path": "%s",\n  "type": "stdio",\n  "allowed_origins": ["chrome-extension://%s/"]\n}\n' \
      "$name" "$desc" "$REPO_DIR/$script" "$EXT_ID" > "$target"
    echo "installed $target"
  done
done

if [[ $count -eq 0 ]]; then
  echo "No Chromium-based browser profile directories found under $BASE." >&2
  echo "Launch your browser once, then re-run this script." >&2
  exit 1
fi

if [[ $UNINSTALL -eq 0 ]]; then
  cat <<EOF

Next:
  1. Open chrome://extensions, enable Developer mode
  2. "Load unpacked" -> $REPO_DIR/extension
  3. Click the Term Here toolbar button (or press Alt+T) on any page
  4. For webshell with host files: open it, approve the site once.
     For webshell opened from file://, also enable "Allow access to file URLs" for Term Here.
EOF
fi
