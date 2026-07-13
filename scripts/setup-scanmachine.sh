#!/bin/zsh
# Zet déze machine (de vaste iMac) op als scan-machine voor The Euro Food Monitor.
# Installeert de drie dagelijkse jobs die eerst op Reins MacBook draaiden:
#   12:00  inkoopscan      (bot-repo, scan.js — IMAP-factuurscan)
#   12:20  plates-sync     (webapp-repo, scripts/sync-notion-plates.js — Notion-spiegel)
#   12:30  import-review   (webapp-repo, scripts/passard-import-review.js)
#
# DRAAI DIT PAS NA de voorbereiding (zie checklist):
#   1. beide repos gecloned, 2. .env / .env.local geplaatst, 3. npm install gedaan.
#
#   ./scripts/setup-scanmachine.sh [pad-naar-webapp-repo]
#
# Idempotent: opnieuw draaien vervangt de jobs gewoon.
set -e

BOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WEB_DIR="${1:-$HOME/euroworld/europizza-calculator}"
NODE_BIN="$(command -v node || true)"

[ -z "$NODE_BIN" ] && { echo "❌ node niet gevonden — installeer eerst: brew install node"; exit 1; }
[ -f "$BOT_DIR/.env" ] || { echo "❌ $BOT_DIR/.env ontbreekt — zet de secrets eerst over (AirDrop/USB)"; exit 1; }
[ -d "$WEB_DIR" ] || { echo "❌ webapp-repo niet gevonden op $WEB_DIR — geef het pad mee als argument"; exit 1; }
[ -f "$WEB_DIR/.env.local" ] || { echo "❌ $WEB_DIR/.env.local ontbreekt — zet de secrets eerst over (AirDrop/USB)"; exit 1; }
[ -d "$BOT_DIR/node_modules" ] || { echo "❌ npm install nog niet gedaan in $BOT_DIR"; exit 1; }
[ -d "$WEB_DIR/node_modules" ] || { echo "❌ npm install nog niet gedaan in $WEB_DIR"; exit 1; }

mkdir -p "$HOME/Library/LaunchAgents"

maak_job() {
  local label=$1 uur=$2 minuut=$3 werkdir=$4 script=$5 log=$6
  local plist="$HOME/Library/LaunchAgents/$label.plist"
  # caffeinate -i: machine mag niet indutten tijdens de run; node-pad dynamisch (Intel /usr/local,
  # Apple Silicon /opt/homebrew) — het hardcoden van /usr/local/bin/node was de oude valkuil.
  cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$label</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/zsh</string>
        <string>-lc</string>
        <string>cd "$werkdir" &amp;&amp; /usr/bin/caffeinate -i "$NODE_BIN" $script >> "$werkdir/$log" 2>&amp;1</string>
    </array>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>$uur</integer>
        <key>Minute</key>
        <integer>$minuut</integer>
    </dict>
    <key>RunAtLoad</key>
    <false/>
</dict>
</plist>
PLIST
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$plist"
  echo "  ✓ $label — dagelijks $uur:$(printf '%02d' $minuut) ($werkdir)"
}

echo "Jobs installeren (node: $NODE_BIN)…"
maak_job rest.europa.inkoopscan   12 0  "$BOT_DIR" scan.js                            scan-log.txt
maak_job rest.europa.platessync   12 20 "$WEB_DIR" scripts/sync-notion-plates.js      plates-sync-log.txt
maak_job rest.europa.importreview 12 30 "$WEB_DIR" scripts/passard-import-review.js   import-review-log.txt

echo ""
echo "Energie-instellingen (vraagt je wachtwoord): nooit slapen, wake bij netwerk, herstart na stroomuitval…"
sudo pmset -a sleep 0 disksleep 0 womp 1 autorestart 1 displaysleep 10

cat <<'KLAAR'

✅ Klaar. Nog twee handmatige stappen:
   1. Systeeminstellingen → Gebruikers en groepen → Automatisch inloggen AAN voor deze gebruiker
      (LaunchAgents draaien alleen als de gebruiker is ingelogd — na een stroomstoring logt de
      iMac dan zelf weer in en lopen de scans door).
   2. Testrun, nu meteen:  cd naar de bot-repo en draai  node scan.js
      → check daarna op europizza-calculator.vercel.app of "Laatste scan" is verstrongen.

⚠ Vergeet niet de oude jobs op de MacBook uit te zetten zodra de testrun hier slaagt —
  anders scannen twee machines dezelfde mailbox (dubbele meldingen).
KLAAR
