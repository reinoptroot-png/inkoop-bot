# Scan-wachter — bewakingsagent voor de facturen/pakbonnen-mailpijplijn

`wachter.js` draait onafhankelijk van de scan zelf (eigen launchd-job, elke 30 min — launchd
en niet cron, omdat launchd na wake/reboot het ritme hervat en met `RunAtLoad` direct inhaalt).
Hij verwerkt **geen** mails en repareert **niets**: hij zoekt gaten, storingen en stille fouten
in het ontvang-/parseerproces en meldt die — zodat niets onopgemerkt tussen wal en schip valt.
"De scan draaide niet" telt daarbij als eerste-klas storing (de scan-iMac is altijd-aan, zonder
gebruiker die meekijkt).

## Installatie (op de scan-iMac)

```sh
cd ~/euroworld/inkoop-bot-v9   # bot-repo op de iMac
git pull && ./scripts/setup-wachter.sh          # launchd-job rest.europa.scanwachter, elke 30 min
```

Daarna éénmalig de externe borging in `.env` zetten (zie hieronder) — tot die er is meldt de
wachter dit zelf elke cyclus als open gat.

## Dead-man's switch (harde eis) + alarmkanaal

De wachter kan niet melden dat hij *niet* draaide; dat moet van buitenaf worden opgemerkt.

- `WACHTER_HEARTBEAT_URL` — ping-URL van een extern, van de iMac onafhankelijk systeem
  (bv. https://healthchecks.io: maak een check met period 30 min / grace 30 min; het **uitblijven**
  van de ping is het alarm). Elke geslaagde cyclus POST hierheen; een falende cyclus pingt
  `<url>/fail`. Interne spiegel: tabel `scan_wachter_cycli` (laatste heartbeat queryable).
- Alarmkanaal, bewust los van de mailpijplijn/hetzelfde netwerk:
  - `WACHTER_ALERT_URL` — Slack-compatible webhook (POST `{text}`), **of**
  - `WACHTER_TELEGRAM_BOT_TOKEN` + `WACHTER_TELEGRAM_CHAT_ID` — Telegram.
- Detecteert de wachter zelf dat zijn vorige heartbeat te lang geleden is (slaap/herstart), dan
  meldt hij dat als gat-type `onderbreking_gedetecteerd` met de duur.

Escalatieregels: ernst **hoog** → direct; **midden** > 30 min open → melden; `connectiviteit`
langer dan 2× het wachter-interval → melden. Herhaling max. 1× per 4 uur per gat (niet per
cyclus); bij herstel volgt een ✅-bericht.

## TOOLS & STATE (de daadwerkelijke omgeving)

- **Mailbox-toegang:** read-only IMAP op dezelfde 4 mailboxen als `scan.js` (`IMAP_USER`…`IMAP_USER4`
  uit `.env`). Boxen worden readonly geopend, er wordt nooit `markSeen` gezet, nooit geschreven.
  Alleen headers + BODYSTRUCTURE worden opgehaald (geen bijlage-downloads).
- **Logbron:** `scan-log.txt` in de bot-repo (launchd-stdout van de scan) — alleen actueel op de
  scan-machine; elders rapporteert de wachter "onbekend". Nieuw segment per cyclus via byte-offset
  in het state-bestand.
- **Dashboard-schrijftoegang:** Supabase-tabellen `scan_wachter_gaten` (uitzonderingen-inbox,
  upsert op `gap_id`) en `scan_wachter_cycli` (cyclus-/heartbeat-log). Schema:
  `supabase/scan-wachter.sql`.
- **State:** `wachter-state.json` in de bot-repo — laatste cyclus/heartbeat (onderbrekings-
  detectie), log-offset en alarm-tijdstempels (4-uurs-dedupe). Staat in .gitignore.

## Wat de wachter controleert

| # | Check | Bron/bewijs | Gat-type |
|---|---|---|---|
| 0 | Eigen onderbreking (heartbeat-gat > 2,5× interval) | wachter-state | `onderbreking_gedetecteerd` |
| 0 | Externe borging (heartbeat/alarm-URL) geconfigureerd | .env | `connectiviteit` |
| 1 | launchd-exitcode scan-job, herstart zonder GUI-sessie, slaap in het 12:00-venster (pmset), klokdrift (sntp), schijfruimte, .env-leesbaarheid | launchctl/pmset/sysctl/sntp/df | `connectiviteit` |
| 1 | Dagelijkse scan gedraaid (`instellingen.laatste_scan` < 26 u oud) | Supabase-query | `connectiviteit` |
| 2 | Elk PDF-document (Message-ID + bijlage-index) van een gewhiteliste afzender ouder dan (laatste_scan − 2 u) staat in `verwerkte_emails` | IMAP BODYSTRUCTURE × ledger | `missend` (hoog na 2 gemiste scans) |
| 2 | Gewhiteliste afzender in Spam/Junk (pijplijn leest alleen INBOX) | IMAP-folderscan | `missend` (hoog) |
| 2 | Zelfde leverancier + documentnummer-token in onderwerp op meerdere mails (bewust zónder bedrag-filter: creditnota's tellen mee) | ledger-query | `mogelijk_duplicaat` |
| 3 | Verplichte velden + drempels op `inkoop_facturen`: bedrag €0 (documenttype onbekend), datum > 90 d oud / > 7 d toekomst, leeg/controleteken-documentnummer | Supabase-query | `parse_mislukt` |
| 3 | Afbeelding i.p.v. PDF van gewhiteliste afzender (pijplijn slaat niet-PDF stil over) | BODYSTRUCTURE | `parse_mislukt` |
| 4 | Stille fouten in het nieuwe scan-log-segment (parse-fouten → `hangend`/wacht-op-retry, IMAP-fouten, schrijffouten, overige ⚠) | logregel | `hangend`/`connectiviteit`/`parse_mislukt` |

Confidence-scores worden alleen gerapporteerd als de parser ze levert; deze parser levert er
geen, dus staat er letterlijk "onbekend — parser levert geen score". Geen gaten deze cyclus =
lege lijst + heartbeat, nooit een verzonnen gat.

## Idempotentie & menselijke besluiten

Gaten worden ge-upsert op deterministisch `gap_id` (sha256 van bronsleutel + type): bestaand gat
→ `laatst_gezien`/`retry_teller` bijgewerkt. Een gat dat een méns op `genegeerd` zet komt nooit
terug op `open`. Gaten die niet meer gedetecteerd worden gaan automatisch naar `opgelost` —
maar alléén als hun detectie-domein (kolom `domein`) die cyclus volledig gecontroleerd is; een
mislukte IMAP-verbinding "lost" dus nooit stil mailbox-gaten op.

Dashboard-mapping (uitzonderingen-inbox): `missend`→Gemist · `parse_mislukt`→Actie vereist ·
`mogelijk_duplicaat`→Duplicaat · `connectiviteit`→Actie vereist · `hangend`→Wacht op retry ·
`onderbreking_gedetecteerd`→Actie vereist.

## Bekende blinde vlekken (bewust gedocumenteerd i.p.v. gegokt)

- **Bijlage-niveau binnen een verwerkte mail:** het verwerkt-ledger registreert per máíl, niet
  per bijlage. Een mail met 3 PDF's waarvan de pijplijn er 2 verwerkte, staat als "verwerkt";
  post-hoc is dat verschil niet te tellen. (Parse-fouten per PDF vangt het log-domein wél.)
- **Duplicaat met generiek onderwerp:** `inkoop_facturen` upsert op `factuurnr` — een tweede
  document met hetzelfde nummer overschrijft de rij stil. Zonder nummer in het mail-onderwerp
  is zo'n duplicaat achteraf niet detecteerbaar; flaggen op alleen onderwerp bleek structurele
  ruis (leveranciers hergebruiken onderwerpen wekelijks) en is daarom weggelaten.
- **Wachtwoord-beveiligde/corrupte PDF's** zijn alleen zichtbaar via het scan-log (de wachter
  downloadt geen bijlagen) — die verschijnen dus als `hangend` via het log-domein.

## Wat de wachter NIET doet

Pijplijn repareren, mails verwerken/markeren, data of confidence verzinnen, of door een mens
genegeerde items heropenen.
