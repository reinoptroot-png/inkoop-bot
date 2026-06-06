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

### Detail view (rechts)
- Gerechtnaam + Notion link linksboven
- Status badge naast naam (Huidig menu / Binnenkort / Archief) — klikbaar dropdown
- Verkoopprijs rechtsboven aanpasbaar — klik "aanpassen", typ nieuw bedrag, Enter = opslaan. Schrijft terug naar Notion via /api/update-vk. Supabase price_overrides voor realtime sync.
- 4 metric kaarten: VK excl. BTW / Foodcost / FC % / Brutowinst
- Ingrediënten tabel met kolommen: Ingrediënt / Eenheid / Hoeveelheid / Yield % / Bruto / Prijs (€/kg of €/st) / Kostprijs / ×
- Autocomplete bij ingrediënt invullen: fuzzy match op Inkoop Prijzen database, toont leverancier + prijs in dropdown, yield automatisch ingevuld
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

## Fase 3 — Scan conflict melding + alias suggesties (PRIORITEIT)

### 3a — Automatische alias suggestie (inkoop bot)

#### Probleem
De inkoop bot maakt bij een fuzzy match (>80%) automatisch een alias aan zonder bevestiging. Bij een verkeerde match (bijv. "kip dij" → "kip filet") ontstaat stille datavervuiling.

#### Gewenst gedrag
Wanneer de bot een nieuw product tegenkomt dat qua naam lijkt op een bestaand ingredient (fuzzy match >80%), wordt **niet automatisch** een alias aangemaakt. In plaats daarvan:

1. Bot schrijft de suggestie naar Supabase tabel `alias_suggestions`:
   ```
   id, scan_naam, bestaand_naam, bestaand_page_id, score, status ('pending')
   ```
2. Inkoop monitor of Ingrediënten pagina toont een banner:
   > "Is **'[scan naam]'** hetzelfde als **'[bestaand ingredient]'**? Dan voegen we een alias toe."
3. **Ja** → alias wordt toegevoegd aan het bestaande ingredient in Notion, `status: 'accepted'`
4. **Nee** → nieuw ingredient aangemaakt zoals normaal, `status: 'rejected'`
5. Pending suggesties blijven zichtbaar totdat ze worden afgehandeld

#### Te bouwen
- `notion-sync.js`: bij fuzzy match → schrijf naar Supabase i.p.v. auto-alias
- Supabase tabel `alias_suggestions` aanmaken
- API route `POST /api/alias-suggestie` — verwerkt ja/nee beslissing
- UI banner in Ingrediënten pagina (pages/ingredienten.js) bovenaan observaties
- Inkoop bot `headless.js`: SUPABASE_URL + SUPABASE_ANON_KEY env vars toevoegen

#### Datamodel Supabase
```sql
create table alias_suggestions (
  id uuid primary key default gen_random_uuid(),
  scan_naam text not null,
  bestaand_naam text not null,
  bestaand_page_id text not null,
  score numeric not null,
  status text default 'pending', -- 'pending' | 'accepted' | 'rejected'
  created_at timestamptz default now()
);
```

---

### 3b — Automatische deduplicatie bij import ✅ GEBOUWD

#### Probleem
De inkoop bot maakt bij elke scan een nieuw ingredient aan als de naam net iets afwijkt (bijv. gewicht of leveranciersnaam in de naam). Zo ontstaan stille dubbelen zoals "buffel mozzarella campa, 250gr" naast "buffel mozzarella campa" — zelfde product, zelfde prijs, zelfde leverancier.

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

### 3c — Scan conflict melding (PRIORITEIT)

#### Probleem
Als twee scans tegelijk lopen (bijv. na `--rescan`) of als een scan een ingredient bijwerkt dat net handmatig is aangepast, overschrijft de bot stilletjes de handmatige waarde.

#### Gewenst gedrag
- Bot detecteert of een ingredient in de afgelopen 30 minuten handmatig is bijgewerkt (`Laatste update` veld in Notion)
- Zo ja: slaat de bot-update over en logt een conflict waarschuwing
- Conflict wordt zichtbaar in de Inkoop monitor als een melding: "Bot wilde [naam] bijwerken maar er was een recente handmatige wijziging"

#### Te bouwen
- `notion-sync.js` `updatePriceOnly()`: check `Laatste update` voor schrijven
- Conflicten loggen naar console én optioneel naar Supabase `scan_conflicts` tabel

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
- Chevron ›

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
