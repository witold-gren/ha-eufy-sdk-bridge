#!/bin/sh
# Wdraża lokalną aplikację „eufy-sdk bridge (local)” na udział Samba „addons”.
# Pliki mostka bierze z forka ~/Home Assistant/ha-eufy-sdk-bridge (bieżąca gałąź).
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
BRIDGE="$HERE/../ha-eufy-sdk-bridge"
DEST=/Volumes/addons/eufy_sdk_bridge_local
[ -d /Volumes/addons ] || { echo "Zamontuj smb://homeassistant/addons"; exit 1; }
[ -f "$BRIDGE/streams.mjs" ] || { echo "Brak forka mostka w $BRIDGE"; exit 1; }
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp -R "$HERE/addon/." "$STAGE/"
mkdir -p "$STAGE/bridge"
cp "$BRIDGE/streams.mjs" "$STAGE/bridge/"
cp "$BRIDGE/server.mjs" "$STAGE/bridge/"
cp "$BRIDGE/go2rtc-config.mjs" "$STAGE/bridge/"
cp -R "$BRIDGE/src" "$STAGE/bridge/src"
# SMB: --inplace, bo zapis przez plik tymczasowy i zmianę nazwy bywa odrzucany
rsync -a --inplace --delete --exclude '.DS_Store' "$STAGE/" "$DEST/"
echo "Wdrożono $(grep '^version' "$HERE/addon/config.yaml") z gałęzi $(git -C "$BRIDGE" rev-parse --abbrev-ref HEAD) ($(git -C "$BRIDGE" rev-parse --short HEAD))"
