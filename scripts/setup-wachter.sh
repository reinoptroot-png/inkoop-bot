#!/bin/zsh
# Installeert de scan-wachter (wachter.js — bewakingsagent voor de facturen/pakbonnen-pijplijn)
# als launchd-job op DEZE machine. Bedoeld voor de scan-iMac: daar zijn óók de machine-checks
# (launchctl/pmset/boottime) en het scan-log zinvol; elders draait alleen de data-kant.
#
#   ./scripts/setup-wachter.sh            # elke 30 min (default)
#   ./scripts/setup-wachter.sh 15         # ander interval in minuten
#
# Launchd + StartInterval (géén cron): na slaap/herstart hervat launchd het ritme vanzelf, en
# RunAtLoad zorgt dat er direct na (her)laden een cyclus draait — een gemiste nacht wordt dus
# meteen ingehaald én als "onderbreking_gedetecteerd" gemeld.
# Idempotent: opnieuw draaien vervangt de job gewoon.
set -e

BOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
INTERVAL_MIN="${1:-30}"
NODE_BIN="$(command -v node || true)"
LABEL="rest.europa.scanwachter"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

[ -z "$NODE_BIN" ] && { echo "❌ node niet gevonden — installeer eerst: brew install node"; exit 1; }
[ -f "$BOT_DIR/.env" ] || { echo "❌ $BOT_DIR/.env ontbreekt"; exit 1; }
[ -d "$BOT_DIR/node_modules" ] || { echo "❌ npm install nog niet gedaan in $BOT_DIR"; exit 1; }

if ! grep -q WACHTER_HEARTBEAT_URL "$BOT_DIR/.env"; then
  echo "⚠ WACHTER_HEARTBEAT_URL staat nog niet in .env — de dead-man's switch (harde eis) is dan"
  echo "  niet actief; de wachter meldt dit zelf elke cyclus als open gat. Zie WACHTER.md."
fi

mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/zsh</string>
        <string>-lc</string>
        <string>cd "$BOT_DIR" &amp;&amp; WACHTER_INTERVAL_MIN=$INTERVAL_MIN "$NODE_BIN" wachter.js >> "$BOT_DIR/wachter-log.txt" 2>&amp;1</string>
    </array>
    <key>StartInterval</key>
    <integer>$(( INTERVAL_MIN * 60 ))</integer>
    <key>RunAtLoad</key>
    <true/>
</dict>
</plist>
PLIST
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "✓ $LABEL — elke $INTERVAL_MIN min (repo: $BOT_DIR, log: wachter-log.txt)"
echo "  Status:  launchctl list $LABEL"
echo "  Testrun: node wachter.js --dry-run"
