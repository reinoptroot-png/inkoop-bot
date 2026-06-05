# Inkoop Bot v9

Desktop app voor Euroworld — monitort leveranciersfacturen via IMAP en vergelijkt prijzen met Notion.

## Wat het doet

1. Scant IMAP mailbox(en) op nieuwe e-mails met PDF-bijlagen
2. Claude (Anthropic) leest de factuur en extraheert ingrediënten + prijzen
3. Vergelijkt met de Notion Ingrediënten database
4. Toont een alert bij prijsafwijkingen boven de drempelwaarde
5. Werkt Notion automatisch bij met de nieuwe prijs

---

## Installatie op een nieuwe Mac

### Vereisten

- [Node.js 20+](https://nodejs.org) — via website of `brew install node`
- Git — standaard aanwezig, anders via Xcode Command Line Tools

### Stap 1 — Clone de repository

```bash
git clone https://github.com/reinoptroot-png/inkoop-bot.git
cd inkoop-bot
```

### Stap 2 — Installeer dependencies

```bash
npm install
```

### Stap 3 — Configureer inloggegevens

```bash
cp .env.example .env
```

Open `.env` en vul de waarden in:

```env
IMAP_HOST=imap.one.com
IMAP_PORT=993
IMAP_USER=facturen@europizza.rest
IMAP_PASS=jouwwachtwoord

# Optioneel: tweede mailbox
IMAP_USER2=facturen@europa.rest
IMAP_PASS2=jouwwachtwoord2

NOTION_TOKEN=ntn_...
NOTION_DB_ID=b6258a232e6d4482b7b4f50cf449854f

ANTHROPIC_KEY=sk-ant-...
ALERT_THRESHOLD=10
```

> **Let op:** `.env` en `settings.json` staan in `.gitignore` en worden nooit gecommit.

### Stap 4 — Starten

**Desktop app (Electron UI):**
```bash
npm start
```

**Headless scan (zonder UI, voor automatisering):**
```bash
npm run scan
```

---

## Docker

Handig voor automatische scans op een server of via cron.

```bash
# Bouwen
docker build -t inkoop-bot .

# Eénmalig draaien
docker run --env-file .env inkoop-bot

# Cron — dagelijkse scan om 08:00
# 0 8 * * * docker run --rm --env-file /pad/naar/.env inkoop-bot
```

---

## Instellingen (Electron UI)

Instellingen zijn ook via de app in te vullen. Ze worden opgeslagen in  
`~/Library/Application Support/inkoop-bot/settings.json` (macOS).

| Veld | Waarde |
|---|---|
| IMAP Host | `imap.one.com` |
| IMAP Poort | `993` |
| Notion Token | Notion integration token |
| Notion DB ID | `b6258a232e6d4482b7b4f50cf449854f` |
| Anthropic Key | Claude API key |
| Alert drempel | `10` (procent) |

---

## Ondersteunde leveranciers

| Leverancier | E-maildomein |
|---|---|
| Lindenhoff | `lindenhoff.nl` |
| Vleeschatelier | `vleeschatelier.nl` |
| Vanilla Venture | `vanillaventure.nl` |
| Sligro | `notifications.order2cash.com` |
| Novitalia | `novitalia.nl` |
| Asperges Amsterdam | `deliver.moneybird.com` |

---

## Structuur

```
src/
  main.js          — Electron entry point
  headless.js      — Headless runner (Docker / cron / .env)
  imap-scanner.js  — IMAP verbinding + PDF parsing
  notion-sync.js   — Notion lezen en schrijven
  store.js         — Instellingen opslag (Electron userData)
  preload.js       — Electron preload bridge
scripts/
  batch-classify.js
  fix-duplicates.js
ui/                — Electron frontend HTML/CSS/JS
```
