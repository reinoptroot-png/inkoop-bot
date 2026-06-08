# Europizza Calculator — Specificatie

## Navigatie
Vier tabbladen in de topbar, op elke pagina consistent:
- **Calculator** → /
- **Menu** → /menu
- **Inkoop monitor** → /inkoop
- **Recepten** → /recepten (placeholder, binnenkort)

Volgorde in topbar: Calculator / Menu / Inkoop monitor / Recepten

---

## Calculator (pages/index.js)

### Sidebar (185px)
- Sectie **Huidig menu** met gekleurde groene stip per gerecht, gegroepeerd per categorie (Snack / Plate / Pizza / Dessert)
- Sectie **Binnenkort** met oranje stip, zelfde categoriegroepering
- Onderaan inklapbare **Archief** sectie (grijs, italic)
- Geen ··· knoppen, geen kanban knop
- Status opgeslagen in Supabase `menu_status` tabel, realtime sync tussen gebruikers
- ✅ **Directe selectie nieuw gerecht**: als de Calculator wordt geopend via `/?gerecht={id}` (bijv. na aanmaken vanuit Menu), wordt het gerecht met dat ID direct geselecteerd in de sidebar — niet het eerste in de lijst. `router.query.gerecht` wordt uitgelezen in `fetchPlates()` én via een `useEffect` op `router.isReady` als fallback voor Next.js hydration timing.

### Detail view (rechts)
- Gerechtnaam + Notion link linksboven
- Status badge naast naam (Huidig menu / Binnenkort / Archief) — klikbaar dropdown
- Verkoopprijs rechtsboven aanpasbaar — klik "aanpassen", typ nieuw bedrag, Enter = opslaan. Schrijft terug naar Notion via /api/update-vk. Supabase price_overrides voor realtime sync.
- ✅ **VK sync Menu ↔ Calculator**: verkoopprijs is consistent tussen beide pagina's. Realtime Supabase updates schrijven ook naar `localStorage('ep-vk-overrides')` zodat de prijs na een page refresh behouden blijft. Zowel `index.js` als `menu.js` gebruiken dezelfde bron.
- 4 metric kaarten: VK excl. BTW / Foodcost / FC % / Brutowinst
- Ingrediënten tabel met kolommen: Ingrediënt / Eenheid / Hoeveelheid / Yield % / Bruto / Prijs (€/kg of €/st) / Kostprijs / ×
- Autocomplete bij ingrediënt invullen: fuzzy match op Inkoop Prijzen database, toont leverancier + prijs in dropdown, yield automatisch ingevuld
- ✅ **Leverancier in snelle onboarding**: mini-formulier bij "nieuw ingredient" heeft een leverancier-veld (naast naam, prijs, eenheid, yield). Wordt opgeslagen via `/api/nieuw-ingredient` naar Notion Inkoop Prijzen.
- Eigen ingrediënten toevoegen zonder match werkt ook (prijs blijft leeg)
- Donut chart prijsopbouw (Foodcost / BTW 9% / Personeel 35% / Overige kosten 15% / Brutowinst) en kostensamenvatting naast elkaar onderaan
- Sync → Notion knop

### Alles stijl
- Achtergrond: #f5f4f0
- Topbar: #e8e0d4
- Font: -apple-system, BlinkMacSystemFont, Segoe UI
- Borders: 0.5px solid #ddd
- Groen: #2a7a3b
- Oranje/amber: #c07b2e
- Rood: #c0392b

---

## Menu (pages/menu.js)

### Bovenaan
4 statkaarten: Gem. foodcost % / Huidig menu (aantal) / Binnenkort (aantal) / Archief (aantal)

### Filter
Pills: Alle / Huidig menu / Binnenkort

### Tabel
- Gegroepeerd per categorie: Snack / Plate / Pizza / Dessert
- Kolommen: Gerecht / Status badge / VK / FC % / Marge
- FC % kleuren: groen <25%, oranje 25-30%, rood >30%
- Onderaan inklapbare Archief sectie met toggle

---

## Inkoop monitor (pages/inkoop.js)

### Statusbalk
Laatste scan datum / Producten (aantal) / Leveranciers (aantal) / Alerts >5% (aantal rood) / Gerechten onder druk (aantal oranje)

### Twee subtabs

#### Tab 1: Alerts & onder druk
- **Stijgers**: alle producten met prijsstijging >5% als kaartjes (auto-fit grid, minmax 180px). Per kaart: naam, leverancier, was-prijs, nieuwe prijs, % wijziging rood, SVG sparkline
- **Dalers**: zelfde maar groen
- Als geen alerts: toon top 8 duurste ingrediënten als kaartjes (naam, leverancier, grote prijs prominent)
- **Gerechten onder druk**: horizontaal staafdiagram per gerecht. FC% was (grijs) vs nu (rood/groen). Verticale grens op 25%. Oorzaak: welk ingredient steeg/daalde + hoeveel gram in recept. VK advies om onder 25% te blijven. Berekening: match ingrediëntnamen uit gerecht (plates API) met inkoopprijzen database op naam. Als geen match: gerecht weglaten. Geen placeholder — dit werkt al met beschikbare data.

#### Tab 2: Prijzen & leveranciers
- Zoekbalk + filter pills per leverancier (Alle / Lindenhoff / Vleeschatelier / Vanilla Family)
- Sorteerbare tabel: Ingredient ↕ / Leverancier / Prijs ↕ / Eenheid / Wijziging %
- Resultaatteller rechts

### Data filtering
- Sligro volledig uit alle data filteren
- Drank blacklist: coca cola, club mate, alpro, ginger beer, arla, schulp, heineken, cynar, spa, sourcy, lipton, red bull, fever tree, tonic water, bier, beer, wijn, wine, prosecco, champagne, frisdrank, sap, siroop, melk, milk, oat drink, soy drink, margarine, koffie, coffee, thee, tea, nespresso, senseo, smoothie, cocktail, energy drink, water

---

## Recepten (pages/recepten.js)
Placeholder pagina. Uitleg + roadmap items. Binnenkort badge in navigatie.

---

## Fase 5 — Recept-rijen in Calculator

### Wat
Naast `+ ingrediënt` en `+ bonus` staat een `+ recept` knop in de ingrediënten tabel van de Calculator.

### Recept-rij velden
- **Naam** — vrij in te typen (later te koppelen aan Recipes database)
- **Eenheid** — gram of stuks (dropdown)
- **Hoeveelheid** — getal
- **Prijs per eenheid** — €/kg of €/st, handmatig in te vullen

### FC% berekening
Recept-rijen tellen volledig mee in de foodcost berekening via de bestaande `ingFC()` functie.

### Visueel onderscheid
- Achtergrond: `#f7f6fd` (lichtpaars)
- Badge "recept · fase 5" in paars (`#7c6db5`, achtergrond `#eeebfb`)
- Knop `+ recept`: paarse tekst en rand (`color: #7c6db5, borderColor: #c4b8e8`)

### Datamodel
`isRecept: true` vlag op het extra-rij object in `layer[plateId].extra[]`, zelfde structuur als bestaande extra-rijen en bonus-rijen.

### Fase 5 — koppeling Recipes database (later)
Naam-veld wordt autocomplete op Notion Recipes database. Prijs automatisch berekend op basis van recept-ingrediënten.

---

## Technische details

### Supabase
- URL: https://viqxafualoybzuycsked.supabase.co
- Key: NEXT_PUBLIC_SUPABASE_ANON_KEY (in Vercel env vars)
- Tabellen: `menu_status` (dish_id, dish_name, status, updated_by, updated_at), `price_overrides` (dish_id, dish_name, selling_price, updated_by, updated_at)

### Naamscherm bij opstarten (pages/_app.js)
- Toont bij eerste bezoek een scherm met alleen "Naam:" input + "Doorgaan →" knop
- Naam wordt opgeslagen in `ep-me` (localStorage) met `nameSet: true` flag
- Geldt voor alle tabbladen via `_app.js` wrapper
- Na invullen direct door naar de gevraagde pagina, geen redirect
- Fase 6: combineren met laadanimatie

### Multi-user realtime samenwerking
Drie features via Supabase Realtime:

**1. Presence indicators**
- Channel: `calc-presence` (Supabase Presence)
- Elke browser krijgt een stabiele userId + naam + kleur (opgeslagen in localStorage als `ep-me`)
- Presence-state wordt bijgewerkt bij elke gerecht-wissel (track met `plateId`)
- SidebarItem toont gekleurde initialen-avatars van andere gebruikers die hetzelfde gerecht open hebben

**2. Co-edit melding**
- Als twee gebruikers tegelijk hetzelfde gerecht openen: blauwe melding boven de ingrediënten tabel: "X is ook in dit gerecht"
- Melding verdwijnt automatisch als de andere gebruiker navigeert

**3. Realtime wijzigingen**
- Broadcast events `layer` en `prijzen` op `calc-presence` channel
- Elke `saveLayer()` / `savePrijzen()` stuurt een broadcast naar andere gebruikers
- Ontvangen wijzigingen worden direct in de state gezet — geen page refresh nodig
- Eigen broadcasts worden genegeerd (userId check)

### Notion databases
- Europizza gerechten: 9d9f404d-3072-4857-a3be-860d52355727
- Inkoop Prijzen: b6258a232e6d4482b7b4f50cf449854f
- Inkoop Geschiedenis: 2d313fcc4d2f480c84ee3344a70cbdcb

### Notion token
- NOTION_TOKEN in Vercel env vars

### API routes
- GET /api/plates — haalt gerechten op uit Notion
- GET /api/inkoop — haalt prijzen + history op, berekent trends
- POST /api/sync — schrijft foodcost terug naar Notion
- POST /api/update-vk — schrijft verkoopprijs terug naar Notion

---

---

## Fase 3 — Scan meldingen systeem (PRIORITEIT)

### 3a — Automatische deduplicatie bij import ✅ GEBOUWD

#### Gedrag (geïmplementeerd in `src/notion-sync.js`)
Wanneer de bot een nieuw product wil aanmaken, doorloopt `syncAll()` vier stappen:
1. **Exacte match** (naam of bestaande alias) → prijs bijwerken
2. **Dedup-check** (`findDedupMatch`): >90% naamovereenkomst (max van token-Jaccard en Levenshtein-ratio) + zelfde leverancier + zelfde prijs (±1%) → scan-naam als alias toevoegen, **geen prijs-update**, `[DEDUP]` log
3. **Fuzzy match** (>80%, `findFuzzyMatch`) → alias toevoegen + prijs bijwerken
4. **Nieuw product** → Claude Haiku classificeert, daarna aanmaken

#### Grens: wanneer WEL een nieuw ingredient
- Match <90% op naam
- Zelfde naam maar andere leverancier of andere prijs (echt ander product of andere verpakking)
- Geen enkel actief ingredient in de database

#### Implementatie
- `tokenJaccard(a, b)`: token-overlap op spatie/komma-gesplitste namen (geen externe dependency)
- `findDedupMatch(naam, price, leverancier, existing)`: combineert Jaccard + Levenshtein, checkt lev+prijs
- Log-prefix: `[DEDUP]` zichtbaar in console én scan-log

---

### 3b — Meldingen systeem: UI + datamodel

#### Doel
Elke scanrun schrijft gestructureerde meldingen naar Supabase. De Inkoop monitor toont deze meldingen bovenaan de pagina. De navigatietab toont een badge met het aantal ongelezen meldingen.

---

#### Vier meldingstypen

**1. Groen — kleine prijswijziging (<10%), automatisch bijgewerkt**
- Tekst: "Product herkend! **[naam]** (leverancier) — prijs bijgewerkt van €X naar €Y (+Z%). Automatisch verwerkt."
- Geen actieknoppen — informatief
- Wordt bij openen automatisch als gelezen gemarkeerd

**2. Oranje — grote prijswijziging (>10%), actie vereist**
- Tekst: "Product herkend! **[naam]** (leverancier) — grote prijsstijging van €X naar €Y (+Z%). Controleer of dit klopt."
- Knoppen: **Accepteren** (status → `accepted`, prijs definitief) | **Negeren** (status → `ignored`, prijs blijft oud)
- Blijft ongelezen totdat gebruiker een keuze maakt

**3. Blauw — nieuw product gevonden**
- Tekst: "Nieuw product gevonden! **[scan naam]** (leverancier) — nog niet in de database. Wil je dit toevoegen?"
- Knoppen: **Bekijken** (opent Ingrediënten editor op het nieuwe product) | **Negeren** (status → `ignored`)
- Blijft ongelezen totdat gebruiker een keuze maakt

**4. Groen met link-icoon — alias herkend, automatisch samengevoegd**
- Tekst: "Product herkend! **[scan naam]** herkend als **[bestaand ingredient]** — alias automatisch toegevoegd."
- Geen actieknoppen — informatief
- Wordt bij openen automatisch als gelezen gemarkeerd

---

#### Notificatiebadge op Ingrediënten tab

- Rode cirkel met getal rechtsbovenaan de "Ingrediënten" tab in de navigatiebalk
- Toont het aantal meldingen met `gelezen = false`
- Badge verdwijnt zodra alle meldingen gelezen zijn (of geen pending oranje/blauwe meldingen meer)
- Telt alleen meldingen van de afgelopen 7 dagen mee
- Pollt elke 60 seconden via `GET /api/meldingen?count=true`

---

#### Meldingen sectie in Ingrediënten pagina (pages/ingredienten.js)

- Bovenaan de pagina, boven de zoekbalk
- Elke melding als een kaartje met gekleurde linkerbalk (groen / oranje / blauw)
- Kaartje bevat: meldingtype-icoon, tekst, tijdstip ("3 uur geleden"), actieknoppen indien van toepassing
- Informatieve meldingen (groen) worden automatisch als gelezen gemarkeerd bij paginabezoek
- Actie-meldingen (oranje/blauw) blijven staan totdat de gebruiker reageert
- "Alles sluiten" knop bovenaan de sectie — markeert alle zichtbare meldingen als gelezen
- Sectie verdwijnt niet als er geen meldingen zijn — toont dan: "Geen nieuwe meldingen"

---

#### Supabase datamodel

```sql
create table scan_meldingen (
  id uuid primary key default gen_random_uuid(),
  type text not null, -- 'prijs_klein' | 'prijs_groot' | 'nieuw_product' | 'alias_herkend'
  ingredient_naam text not null,
  leverancier text,
  prijs_oud numeric,
  prijs_nieuw numeric,
  wijziging_pct numeric,
  scan_naam text,           -- voor alias_herkend: de naam uit de factuur
  bestaand_page_id text,    -- Notion page ID van het bestaande ingredient
  status text default 'pending', -- 'pending' | 'accepted' | 'ignored'
  gelezen boolean default false,
  created_at timestamptz default now()
);

create index on scan_meldingen (gelezen, created_at desc);
```

---

#### Bot-integratie (`src/notion-sync.js`)

Bij elke schrijfactie schrijft `syncAll()` een rij naar `scan_meldingen`:

| Situatie | Type | Status na schrijven |
|---|---|---|
| Prijs bijgewerkt, wijziging ≤10% | `prijs_klein` | `accepted`, `gelezen: false` |
| Prijs bijgewerkt, wijziging >10% | `prijs_groot` | `pending`, `gelezen: false` |
| Nieuw product aangemaakt | `nieuw_product` | `pending`, `gelezen: false` |
| Fuzzy match → alias toegevoegd | `alias_herkend` | `accepted`, `gelezen: false` |

Voor `prijs_groot` en `nieuw_product`: de prijs-update wordt uitgesteld totdat de gebruiker "Accepteren" kiest. Bij "Negeren" blijft de oude prijs staan.

---

#### API routes

- `GET /api/meldingen` — haalt meldingen op (filter: `gelezen=false` of laatste 7 dagen), gesorteerd op `created_at desc`
- `POST /api/meldingen/[id]/lees` — markeert melding als gelezen (`gelezen: true`)
- `POST /api/meldingen/[id]/actie` — body: `{ actie: 'accepted' | 'ignored' }` — verwerkt keuze, markeert gelezen

---

#### Gebouwd ✅
- `pages/api/meldingen/index.js` — GET (lijst + count), POST (bot schrijft melding)
- `pages/api/meldingen/[id].js` — POST `{ actie: 'lees' | 'accepted' | 'ignored' }` + Notion prijsupdate bij `accepted`
- `pages/ingredienten.js` — `MeldingenSectie` bovenaan pagina; informatieve meldingen automatisch gelezen bij paginabezoek
- `lib/shared.js` Topbar — badge op Ingrediënten tab, pollt elke 60s
- `src/headless.js` — schrijft meldingen naar Supabase per scanactie; grote wijzigingen (>10%) stellen Notion-update uit tot gebruiker accepteert
- `@supabase/supabase-js` toegevoegd aan bot `package.json`
- `.env.example` — SUPABASE_URL + SUPABASE_ANON_KEY gedocumenteerd

#### Nog te doen
- Supabase tabel `scan_meldingen` aanmaken (zie SQL in datamodel hierboven)
- `SUPABASE_URL` + `SUPABASE_ANON_KEY` toevoegen aan bot `.env` en Mac cronjob env

---

## Fase 4 — Dagrapport import (Lightspeed)

### Doel
Lightspeed stuurt dagelijks een CSV-rapport naar rein@europa.rest. De inkoop bot scant dit emailadres en importeert de verkoopdata zodat foodcost% per gerecht actueel blijft.

### Mailbox
- IMAP_USER3 = rein@europa.rest
- IMAP_PASS3 = (env var, zelfde imap.one.com server)
- Toevoegen aan headless.js als derde scanpromise (naast IMAP_USER / IMAP_USER2)

### CSV formaat (Lightspeed export)
- Bijlage in email van Lightspeed POS
- Kolommen: datum, gerechtnaam, aantal, omzet excl. BTW
- Parser: nieuwe module src/lightspeed-parser.js

### Wat de bot doet met de data
1. CSV inlezen uit email attachment
2. Per gerecht: omzet + aantal verkopen opslaan
3. Koppelen aan Notion gerechten op naam (fuzzy match, zelfde logica als ingrediënten)
4. Berekening actuele foodcost% updaten in Notion of Supabase

### Nog te bouwen
- src/lightspeed-parser.js — CSV parser + Notion/Supabase schrijflogica
- Koppeltabel gerechtnaam Lightspeed ↔ Notion page ID

---

## Fase 4a — Finance dashboard

### Doel
Na de Lightspeed CSV-koppeling is er voor het eerst gecombineerde omzet- én inkoopdata beschikbaar. Dit dashboard maakt die data zichtbaar op één pagina zodat je in één oogopslag ziet hoe het restaurant financieel presteert.

### Locatie
Nieuwe pagina: `pages/finance.js` — zevende tabblad in de topbar rechts naast Instellingen, of als subtab binnen de Inkoop monitor.

### Vier onderdelen

#### 1. Revenue & Spend trends
- Lijndiagram met twee lijnen over tijd (dag / week / maand — schakelbaar)
- **Omzet** (uit Lightspeed CSV): totale verkoopopbrengst excl. BTW
- **Inkoopkosten** (uit Inkoop Geschiedenis): som van prijzen × verbruikte hoeveelheden per periode
- X-as: datum, Y-as: euro. Schakelaar dag/week/maand rechtsboven
- Kleur omzet: groen (#2a7a3b), kleur inkoop: rood (#c0392b)

#### 2. Supplier spending overzicht
- Horizontaal staafdiagram — één balk per leverancier
- Toont totaal uitgegeven (€) per leverancier over de geselecteerde periode
- Gesorteerd hoog → laag
- Klikbaar: klik op leverancier → filter de Inkoop monitor op die leverancier

#### 3. Bar / Keuken split
- Twee kolommen naast elkaar: **Keuken** en **Bar**
- Per kolom: omzet, inkoopkosten, FC%, brutowinst
- Splitsing op basis van `isDrank` vlag op ingrediënten en Lightspeed productcategorie
- Kleurcodering FC%: groen <25%, oranje 25–30%, rood >30%

#### 4. Cost Percentage trending
- Kaartje per gerecht (Huidig menu) met:
  - Gerechtnaam + huidige FC%
  - Pijltje omhoog (rood) of omlaag (groen) ten opzichte van vorige week
  - Verschil in procentpunten, bijv. "+2,3pp"
- Gesorteerd: hoogste stijging bovenaan
- Alleen gerechten met data in zowel huidige als vorige week

### Data bronnen
| Gegeven | Bron |
|---|---|
| Omzet per dag/gerecht | Lightspeed CSV → Supabase `lightspeed_verkopen` tabel |
| Inkoopkosten | Notion Inkoop Geschiedenis (prijs × hoeveelheid per ingredient per dag) |
| FC% per gerecht | Calculator logica (bestaand) |
| isDrank vlag | Notion Inkoop Prijzen `Is drank` veld |

### Supabase tabel (aanmaken bij Fase 4 implementatie)
```sql
create table lightspeed_verkopen (
  id uuid primary key default gen_random_uuid(),
  datum date not null,
  gerecht_naam text not null,
  notion_page_id text,
  aantal integer,
  omzet_excl_btw numeric,
  categorie text, -- 'keuken' | 'bar'
  created_at timestamptz default now()
);
create index on lightspeed_verkopen (datum desc);
```

### Nog te bouwen
- `pages/finance.js` — dashboard pagina met vier onderdelen
- `pages/api/finance.js` — aggregatiequery's: omzet + inkoop per periode, per leverancier, bar/keuken split, FC% trending
- Supabase tabel `lightspeed_verkopen` aanmaken
- `src/lightspeed-parser.js` uitbreiden met schrijven naar `lightspeed_verkopen`
- Grafiek library: gebruik SVG (zelfde aanpak als bestaande sparklines) of `recharts` indien al aanwezig

---

## Fase 4b — Wekelijkse e-mailrapportage

### Doel
Elke maandag automatisch een e-mail sturen met een samenvatting van de inkoopweek: prijsstijgingen, gerechten onder druk, en top prijsstijgers per leverancier.

### Inhoud van de e-mail
1. **Prijsstijgingen afgelopen week** — alle ingrediënten met een prijswijziging >5% in de afgelopen 7 dagen, gesorteerd op % stijging (hoogste eerst). Per regel: naam, leverancier, was-prijs, nieuwe prijs, % wijziging.
2. **FC% per gerecht** — alle actieve gerechten (Huidig menu + Binnenkort) gesorteerd van hoogste naar laagste foodcost%. Per regel: gerechtnaam, FC%, VK, categorie.
3. **Gerechten onder druk** — gerechten met FC% >30%, uitgelicht als waarschuwing. Per gerecht: naam, FC%, oorzaak (welk ingredient steeg + hoeveel).
4. **Top prijsstijgers per leverancier** — per leverancier de top 3 ingrediënten met de grootste prijsstijging die week.

### Verzending
- Elke maandag om 07:00 (Nederlandse tijd), getriggerd via de Mac cronjob (zelfde job als de dagelijkse scan)
- Script: `src/weekly-report.js` — standalone, los van `scan.js`
- Cronjob entry: maandag 07:00 → `node src/weekly-report.js`

### E-mailadressen
- Instelbaar via de **Instellingen pagina** in de webapp (pages/instellingen.js)
- Één of meerdere adressen (komma-gescheiden invoer)
- Opgeslagen in Supabase tabel `instellingen` (key: `rapport_emails`, value: komma-gescheiden string)
- Fallback: als geen adressen ingesteld → geen e-mail verstuurd, alleen console log

### Instellingen pagina (pages/instellingen.js)
- Zesde tabblad in de topbar: Calculator / Menu / Inkoop monitor / Ingrediënten / Recepten / **Instellingen**
- Sectie "Wekelijkse rapportage":
  - Tekstveld: "E-mailadressen (komma-gescheiden)" — bijv. `rein@europa.rest, chef@europizza.rest`
  - Opslaan knop → schrijft naar Supabase `instellingen`
  - Bevestiging: "Instellingen opgeslagen" toast
- Later uitbreidbaar met andere instellingen (drempel alerts, leverancier-mapping, etc.)

### Technische aanpak
- `src/weekly-report.js`:
  1. Laad prijshistorie uit Notion Inkoop Geschiedenis (afgelopen 7 dagen)
  2. Laad gerechten + ingrediënten uit Notion via `/api/plates` logica
  3. Bereken FC% per gerecht (zelfde logica als Calculator)
  4. Stel e-mail samen als plain-text + eenvoudige HTML tabel
  5. Verstuur via nodemailer (SMTP, zelfde credentials als IMAP)
  6. Lees `rapport_emails` uit Supabase `instellingen` tabel

### Supabase tabel
```sql
create table instellingen (
  key text primary key,
  value text,
  updated_at timestamptz default now()
);
-- Initieel: insert into instellingen (key, value) values ('rapport_emails', '');
```

### Nog te bouwen
- `src/weekly-report.js` — dataverzameling, FC%-berekening, e-mail opmaak, verzending
- `pages/instellingen.js` — Instellingen pagina met rapport_emails veld
- `pages/api/instellingen.js` — GET/POST route voor Supabase `instellingen` tabel
- Supabase tabel `instellingen` aanmaken
- Maandag cronjob entry toevoegen aan Mac cronjob configuratie
- Nodemailer dependency toevoegen (`npm install nodemailer`)

---

## Fase 4c — Onboarding wizard

### Doel
Bij eerste gebruik doorloopt een nieuwe gebruiker een begeleide setup flow zodat de bot meteen correct geconfigureerd is. Legt tevens de basis voor eventuele toekomstige multi-tenant uitbreiding (meerdere restaurants op dezelfde installatie).

### Flow (vier stappen)

#### Stap 1 — Restaurant naam
- Invoerveld: restaurantnaam (bijv. "Europizza")
- Optioneel: logo uploaden (afbeelding, wordt opgeslagen in Supabase Storage)
- Wordt opgeslagen als `restaurant_naam` in Supabase `instellingen` tabel
- Getoond in de topbar naast het EP-logo (vervangt "EP" als ingesteld)

#### Stap 2 — Leveranciers selecteren
- Lijst met bekende Nederlandse leveranciers als selecteerbare pills:
  **Bidfood · Hanos · Sligro · Lindenhoff · Vleeschatelier · Vanilla Venture · Van Gelder · Rungis · Bolomey · Dun Yong · Overig**
- Meervoudige selectie — minimaal één verplicht
- Per geselecteerde leverancier: optioneel een factuure-mailadres koppelen (bijv. `facturen@europizza.rest`)
- Geselecteerde leveranciers worden opgeslagen als `actieve_leveranciers` in `instellingen`

#### Stap 3 — Eerste factuur uploaden als test
- Bestandsupload (PDF) — drag-and-drop of klik
- Bot verwerkt de factuur direct (zelfde Claude-extractie als bij IMAP-scan)
- Toont de geëxtraheerde producten als preview-tabel: naam / prijs / eenheid / leverancier
- Gebruiker kan per rij goedkeuren of verwijderen vóór opslag in Notion
- Sla resultaat op in Notion Inkoop Prijzen na bevestiging

#### Stap 4 — Verificatie
- Toont samenvatting: "X producten gevonden bij Y leverancier(s)"
- Statuscheck: Notion-verbinding ✓ / Supabase ✓ / IMAP (als ingesteld) ✓ of ✗
- Knop "Start gebruiken" → wizard afsluiten, `onboarding_voltooid: true` in `instellingen`
- Optioneel: direct naar Ingrediënten pagina of Calculator

### Wanneer tonen
- Wizard toont als `onboarding_voltooid` ontbreekt of `false` is in Supabase `instellingen`
- Na voltooiing nooit meer automatisch tonen — wel bereikbaar via Instellingen pagina ("Setup opnieuw doorlopen")

### Multi-tenant basis
- Elke `instellingen`-rij heeft een `restaurant` kolom (nu altijd `'europizza'`)
- Wizard schrijft altijd naar `restaurant = 'europizza'` — structuur is klaar voor meerdere restaurants zonder code-aanpassing
- Toekomstige uitbreiding: login-scherm → restaurant kiezen → eigen instellingen laden

### Technische aanpak
- `pages/onboarding.js` — wizard pagina (vier stappen als state machine: `stap: 1 | 2 | 3 | 4`)
- `pages/api/onboarding/upload.js` — POST route: ontvangt PDF, roept Claude-extractie aan, retourneert preview
- `pages/api/onboarding/bevestig.js` — POST route: schrijft goedgekeurde producten naar Notion
- `pages/_app.js` — check `onboarding_voltooid` bij startup (naast naam-check); redirect naar `/onboarding` als niet voltooid
- Wizard styles: zelfde palet als naamscherm (#f5f4f0, wit card, groen knop)

### Nog te bouwen
- `pages/onboarding.js` — vier-stap wizard
- `pages/api/onboarding/upload.js` — PDF upload + Claude-extractie
- `pages/api/onboarding/bevestig.js` — Notion schrijflogica
- `pages/_app.js` — onboarding check toevoegen aan startup flow
- `instellingen` tabel uitbreiden: `onboarding_voltooid boolean default false`, `restaurant_naam text`, `actieve_leveranciers text`

---

## Database opschoning — 2026-06-06 ✅ VOLTOOID

Uitgevoerd op Notion Inkoop Prijzen database (`b6258a232e6d4482b7b4f50cf449854f`):

- **12 non-food/schoonmaakartikelen gearchiveerd** — handschoenen, vaatwasmiddel, poetsrol, reiniger, vacuumzak, handzeep, oven grill reiniger, schuurspons, pb dikke bleek, yoni dispenser, dr. schnell perojet, sfg stalen tussenschot
- **31 dranken geflagd** (`isDrank: true`) — coca-cola varianten, rc ginger beer, alpro, fust bier, appelsap, wijn, champagne, koffiebonen, bier varianten
- **17 near-duplicaten gearchiveerd** — samengevoed met master-ingredient + scan-naam als alias toegevoegd. Bio vs niet-bio nooit samengevoegd.
- **Controleregels**: `coca-cola → coca-cola zero` (ander product) en `witte wijn azijn → rode wijn azijn` (ander product) bewust NIET samengevoegd.
- Verificatiescript: `scripts/cleanup-2026-06-06.js`

---

## Wat NIET doen
- Geen Sligro data tonen
- Geen localStorage voor menu-status (gebruik Supabase)
- Geen kanban of apart menu-indeling scherm
- Geen ··· hover knoppen in sidebar

---

## Ingrediënten systeem

### Naamgeving
- Altijd lowercase Nederlands: `burrata`, `lam rack`, `pine nuts`, `fior di latte`
- Geen verpakkingsinfo, geen gewicht in de naam
- Leverancier altijd vermeld

### Notion Inkoop Prijzen database (b6258a232e6d4482b7b4f50cf449854f)
Bestaande kolommen: Ingredient (title), Kostprijs (number), Eenheid (text), Leverancier (text)
Extra kolommen aangemaakt: Categorie (select), Is drank (checkbox), Aliassen (text), Inkoopeenheid (text), Alternatieve leverancier (text)

### Categorieën
zuivel / vlees / vis / groenten / droogwaren / drank

### Aliassen
Komma-gescheiden tekstveld. Bijv: "Burrata di bufala 125g, Burrata Pugliese Lindenhoff, burrata 250g"
Bij matching in de berekening: check zowel de simpele naam als alle aliassen

### Yield
Eenmalig instellen per ingredient in de calculator. Wordt onthouden via localStorage per ingredient naam.

### Inkoopeenheid vs receptuureenheid
Leverancier levert per doos/krat → systeem rekent automatisch om naar prijs per gram/stuk

### Zelflerend systeem (fase 2)
Bij elke nieuwe scan: Claude Haiku classificeert automatisch:
- Is drank: true/false op basis van productnaam
- Categorie: zuivel/vlees/vis/groenten/droogwaren/drank
- Simpele naam (lowercase Nederlands)
Bestaande producten worden NIET overschreven

### Leveranciers
- Lindenhoff: food only
- Vleeschatelier: food only  
- Vanilla Venture: food only
- Sligro: food only — dranken gefilterd via BLACKLIST

### BLACKLIST dranken (case-insensitive, substring match)
coca cola, coca-cola, pepsi, fanta, sprite, 7up, fuze, ice tea, rivella, club mate, alpro, ginger beer, arla, schulp, heineken, cynar, sourcy, lipton, red bull, redbull, fever tree, tonic water, bier, beer, wijn, wine, prosecco, champagne, frisdrank, appelsap, vruchtensap, siroop, syrup, melk, milk, oat drink, soy drink, haverdrink, margarine, koffie, coffee, thee, tea, nespresso, senseo, karnemelk, smoothie, cocktail, energy drink, mountain dew, dr pepper

---

## Gerechten onder druk — berekeningsregels
- Alleen tonen als minstens 3 ingrediënten exact matchen op naam met Inkoop Prijzen
- FC% alleen berekenen als minstens 80% van ingrediënten een prijs hebben
- Anders gerecht weglaten uit de lijst
- Max 10 gerechten
- Staafdiagram: FC% was (grijs) vs FC% nu (rood/groen), grens op 25%
- Oorzaak tonen: welk ingredient steeg/daalde + % wijziging

---

## Calculator UX
- Ingrediënten tabel rijen: padding 8px, input height 32px
- Donut chart en kostensamenvatting naast elkaar onderaan
- Verkoopprijs aanpasbaar rechtsboven
- Archiveer knop: NIET tonen
- Gearchiveerde gerechten: wel klikbaar in inklapbare archief sectie, detail view werkt normaal
- "Alle gerechten" overzicht: NIET tonen — direct naar gerecht detail

---

## Ingrediënten editor (pages/ingredienten.js)

### Navigatie
Vijfde tabblad in topbar: Menu / Calculator / Inkoop monitor / Ingrediënten / Recepten

### Structuur
Categorieën als hoofdstructuur, inklapbaar:
- Zuivel / Vlees / Vis / Groenten / Droogwaren / Specerijen

### Per categorie
Lijst van ingrediënten als rijen. Klik op rij → detail uitklapt inline.

### Rij (collapsed)
- Groene/oranje/grijze stip (gesynchroniseerd vandaag / ouder / handmatig)
- Simpele naam
- Leverancier
- Prijs per kg/st
- Yield %
- ✅ **Bijgewerkt datum** — `laatste_update` uit Notion, geformatteerd als "dd mmm" (bijv. "5 jun"). Vaste breedte, rechts uitgelijnd.
- Chevron ›

### Kolomverdeling ✅
Grid: `minmax(0,2fr) minmax(0,2.5fr) 72px 52px 76px`
- Ingredient: 2fr (smaller)
- Leverancier: 2.5fr (meer ruimte)
- Prijs / Yield / Bijgewerkt: vaste breedte, rechts uitgelijnd

### Detail (expanded)
Drie secties:
1. **Basisinfo**: simpele naam (bewerkbaar), categorie (dropdown), leverancier, inkoopeenheid
2. **Aliassen**: tags met × om te verwijderen, + alias toevoegen knop
3. **Prijshistorie**: mini staafdiagram, was → nu prijs
4. **Yield**: getal invulveld, eenheid dropdown (gram/stuk/ml)
5. **Opslaan** knop → schrijft terug naar Notion Inkoop Prijzen database

### Observaties bovenaan
Vier kaartjes altijd zichtbaar:
- Ontbrekende prijzen (aantal + lijst van ingrediënten zonder prijs)
- Nieuwe producten (ongeclassificeerd uit laatste scan)
- Prijsdekking menu (% gerechten met volledige data)
- Kostenverdeling leveranciers (horizontale balkgrafiek)

### Filterbaar
- Zoekbalk
- Pills per leverancier
- Pill: "Ontbrekend" — toont alleen ingrediënten zonder prijs

### Sync gedrag
- Handmatig ingevoerde waarden (yield, aliassen, prijs) worden NOOIT overschreven door scanner
- Scanner update alleen: Kostprijs, Leverancier, Laatste update
- Handmatige velden: Yield, Aliassen, Inkoopeenheid, Alternatieve leverancier


---

## Fase 6 — Gebruikershandleiding in Notion

### Doel
Een volledige handleiding geschreven in Notion, zodat het keukenteam en nieuwe medewerkers zelfstandig met de app kunnen werken. De handleiding legt uit hoe elk onderdeel werkt, wat de relatie is met Notion, en hoe de inkoop bot op de achtergrond functioneert.

### Locatie
Aparte Notion pagina onder de Europizza workspace: **"Handleiding — Europizza App"**

---

### Inhoud per sectie

#### 1. Introductie
- Wat is de app en waarvoor gebruik je hem
- Welke drie systemen samenwerken: de webapp (Vercel), Notion (database), en de inkoop bot (scanner)
- Wie gebruikt wat: keukenteam → Calculator + Menu; inkoop → Ingrediënten + Inkoop monitor; automatisch → inkoop bot

#### 2. Calculator
- Hoe open je een gerecht
- Hoe werkt de verkoopprijs aanpassen
- Wat betekent foodcost % en wanneer is het te hoog
- Hoe voeg je een ingrediënt toe (autocomplete uitgelegd)
- Verschil tussen ingrediënt / bonus / recept rij
- Wat doet de "Sync → Notion" knop (automatisch na 3 seconden)
- Wat betekent de groene vinkje / spinner in de topbar

#### 3. Menu pagina
- Hoe verander je de status van een gerecht (Huidig menu / Binnenkort / Archief)
- Hoe lees je de FC% kleuren (groen / oranje / rood)
- Wat is de Archief sectie

#### 4. Inkoop monitor
- Wat zijn prijsalerts (>5% wijziging)
- Hoe lees je het staafdiagram "Gerechten onder druk"
- Hoe gebruik je de Prijzen & leveranciers tab
- Welke leveranciers worden gefilterd (Sligro dranken, BLACKLIST)

#### 5. Ingrediënten editor
- Hoe zoek je een ingredient op
- Hoe pas je yield, prijs, aliassen aan
- Wat is een alias en waarom is het belangrijk (matching met facturen)
- Wat is inkoopeenheid vs receptuureenheid
- Hoe verwijder je een ingredient (bevestigingsdialoog)
- Wat betekent de "Ontbrekende prijzen" observatie bovenaan

#### 6. Inkoop bot — hoe werkt het op de achtergrond
- Bot scant dagelijks de mailboxen (facturen@europizza.rest, facturen@europa.rest, rein@europa.rest)
- Herkent PDF-bijlagen van bekende leveranciers
- Claude analyseert de factuur en extraheert producten + prijzen
- Prijzen worden bijgewerkt in de Notion Inkoop Prijzen database
- Prijshistorie wordt bijgehouden (Inkoop Geschiedenis database)
- Alerts worden gegenereerd bij afwijkingen >10%
- Wanneer draait de bot: handmatig via `node src/headless.js`, of `--rescan` voor gelezen mails

#### 7. Multi-user samenwerking
- Naamscherm bij eerste bezoek: vul je naam in zodat collega's je zien
- Presence indicators: initialen in de sidebar tonen wie welk gerecht open heeft
- Co-edit melding: als twee mensen hetzelfde gerecht openen
- Wijzigingen van collega's verschijnen direct (geen refresh nodig)

#### 8. Veel gestelde vragen
- "Mijn foodcost % klopt niet" → controleer of alle ingrediënten een prijs hebben (gele waarschuwing)
- "Een ingredient staat dubbel" → gebruik aliassen om duplicaten samen te voegen
- "De bot heeft de verkeerde prijs opgeslagen" → pas handmatig aan via Ingrediënten editor, wordt niet overschreven
- "Ik zie een alias suggestie" → bevestig of weiger via de melding (Fase 3)

---

### Te bouwen (Fase 6)
- Notion pagina aanmaken met bovenstaande structuur
- Elke sectie als aparte sub-pagina met uitklapbare blokken
- Screenshots van elke pagina toevoegen
- Naamscherm combineren met laadanimatie (zie SPEC naamscherm sectie)
- Link naar handleiding toevoegen in de app (? icoon of "Help" in de topbar)
