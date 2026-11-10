#!/usr/bin/env bash
# Register the Term Here native messaging host with Chromium-based browsers.
#
#   ./install.sh                 install for every browser found
#   ./install.sh --uninstall     remove the registration
#   ./install.sh --extension-id <id>   allow a different extension ID
#
# The default ID matches the "key" in extension/manifest.json, so loading the
# unpacked extension from any path yields the same ID.
set -euo pipefail

HOST_NAME="com.termhere.shell"
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
HOST_PATH="$REPO_DIR/host/term_here_host.py"

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
  chmod +x "$HOST_PATH"
fi

count=0
for b in "${BROWSERS[@]}"; do
  dir="$BASE/$b"
  [[ -d "$dir" ]] || continue
  target="$dir/NativeMessagingHosts/$HOST_NAME.json"
  if [[ $UNINSTALL -eq 1 ]]; then
    [[ -f "$target" ]] && rm -f "$target" && echo "removed  $target" && count=$((count+1))
    continue
  fi
  mkdir -p "$dir/NativeMessagingHosts"
  cat > "$target" <<EOF
{
  "name": "$HOST_NAME",
  "description": "Term Here shell host",
  "path": "$HOST_PATH",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
EOF
  echo "installed $target"
  count=$((count+1))
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
EOF
fi
