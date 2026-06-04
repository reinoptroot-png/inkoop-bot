# Inkoop Bot v9

Desktop app voor Euroworld — monitort leveranciersfacturen via IMAP en vergelijkt prijzen met Notion.

## Wat het doet

1. Scant de IMAP mailbox op nieuwe e-mails met PDF-bijlagen
2. Claude leest de factuur en extraheert ingrediënten + prijzen
3. Vergelijkt met de Notion Ingrediënten database
4. Toont een alert bij prijsafwijkingen boven de drempelwaarde
5. Werkt Notion automatisch bij met de nieuwe prijs

## Installatie

### Vereisten
- Node.js (https://nodejs.org)
- Anthropic API key (https://console.anthropic.com)
- Notion Integration token

### Starten

```bash
cd inkoop-bot-v9
npm install
npm start
```

## Instellingen

### IMAP
- **Host**: imap.one.com
- **Poort**: 993
- **E-mail**: facturen@europizza.rest (of facturen@europa.rest)
- **Wachtwoord**: je one.com wachtwoord

### Notion
- **API Token**: maak een integration aan via https://www.notion.so/my-integrations
  - Geef de integration toegang tot de Ingrediënten database
- **Database ID**: `143025fb08ca80f6b918f1d43e4f6d91`

### Claude API
- **Anthropic API Key**: je key van console.anthropic.com
- **Alert drempel**: standaard 10% — bij grotere afwijking verschijnt een alert

## Gebruik

1. Vul de instellingen in en sla op
2. Klik op **Scan nu** op het Dashboard
3. De app scant ongelezen mails, verwerkt PDF-bijlagen, en toont alerts
4. Bekijk de huidige Notion prijslijst onder **Prijslijst**

## Leveranciers

Werkt met alle leveranciers die facturen of pakbonnen als PDF mailen. Shilla Food Group is momenteel de enige leverancier die mailt naar facturen@.
