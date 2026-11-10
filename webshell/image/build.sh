#!/usr/bin/env bash
# Build the guest OS image into ../os (needs Docker with linux/386 support, python3).
set -euo pipefail
cd "$(dirname "$0")"

IMAGE=webshell-alpine
OUT=../os
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"; docker rm -f "$IMAGE-export" >/dev/null 2>&1 || true' EXIT

docker build --platform linux/386 -t "$IMAGE" .
docker create --platform linux/386 --name "$IMAGE-export" "$IMAGE" >/dev/null
docker export "$IMAGE-export" -o "$TMP/rootfs.tar"

rm -rf "$OUT"
python3 pack.py "$TMP/rootfs.tar" --out "$OUT"
du -sh "$OUT"
