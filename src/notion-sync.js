const { Client } = require('@notionhq/client');
const { Client: PgClient } = require('pg');
const fetch = require('node-fetch');
const { conceptSleutel } = require('./recept-import-lib');

// Duplicaat-fallback (naam+leverancier+eenheid) rechtstreeks via SQL i.p.v. PostgREST: de
// unique-constraint waarop we hier matchen (inkoop_prijzen_naam_lev_eed_uq) is een EXPRESSIE-index
// (naam, lower(coalesce(leverancier,'')), lower(coalesce(eenheid,''))) — PostgREST's upsert
// { onConflict: '<naam>' } accepteert alleen een kale kolomlijst, geen index/constraint-naam en geen
// expressies. Met de indexnaam erin faalde dit altijd met "column ... does not exist". Rechtstreekse
// SQL kan wél op de exacte expressie matchen.
//
// Eén batch kan tegelijk twee soorten conflicten bevatten: (a) een normale her-sync (id bestaat al —
// gewoon updaten) en (b) een écht Notion-datadubbel (twee pagina's/id's voor hetzelfde
// naam+leverancier+eenheid). Eén ON CONFLICT-doel per statement dekt niet allebei, en Postgres staat
// ook niet toe dat één multi-row INSERT dezelfde doelrij twee keer in dezelfde batch raakt. Daarom
// per rij, sequentieel: probeer eerst op id (normale re-sync); levert dat een naam+lev+eenheid-
// botsing op (een ANDER id bezit deze identiteit al), dan update die bestaande rij i.p.v. een tweede
// rij voor hetzelfde fysieke product aan te maken — precies de intentie van de oorspronkelijke
// "duplicaat op naam+lev+eenheid"-fallback.
async function upsertViaNaamLevEenheid(rows) {
  if (!rows.length) return;
  if (!process.env.SUPABASE_DB_URL) throw new Error('SUPABASE_DB_URL ontbreekt — kan duplicaat-fallback (naam+leverancier+eenheid) niet uitvoeren');

  const cols = Object.keys(rows[0]);
  const updateCols = cols.filter(c => c !== 'id');
  const client = new PgClient({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  const dubbelNamen = [];
  try {
    await client.query('begin');
    for (const r of rows) {
      const vals = cols.map(c => r[c]);
      // Savepoint per rij: als de insert faalt, blokkeert een kale rollback de rest van de
      // transactie ("current transaction is aborted") — een savepoint laat alleen déze rij
      // terugdraaien zodat de fallback-update en de volgende rijen gewoon door kunnen.
      await client.query('savepoint rij');
      try {
        await client.query(
          `insert into inkoop_prijzen (${cols.map(c => `"${c}"`).join(',')}) values (${cols.map((_, j) => `$${j + 1}`).join(',')})
           on conflict (id) do update set ${updateCols.map(c => `"${c}" = excluded."${c}"`).join(', ')}`,
          vals
        );
      } catch (e) {
        await client.query('rollback to savepoint rij');
        if (!/inkoop_prijzen_naam_lev_eed_uq/.test(e.message)) throw e;
        // Ander id bezit deze naam+leverancier+eenheid al → die bestaande rij verversen, geen nieuwe
        // rij voor hetzelfde fysieke product aanmaken. Het eigen (nieuwere) id van deze Notion-pagina
        // vervalt hier bewust — de eerder gekozen canonieke rij blijft de bron van waarheid.
        dubbelNamen.push(r.naam);
        const setCols = updateCols.filter(c => c !== 'naam' && c !== 'leverancier' && c !== 'eenheid');
        await client.query(
          `update inkoop_prijzen set ${setCols.map((c, j) => `"${c}" = $${j + 1}`).join(', ')}
           where naam = $${setCols.length + 1} and lower(coalesce(leverancier, '')) = lower(coalesce($${setCols.length + 2}, '')) and lower(coalesce(eenheid, '')) = lower(coalesce($${setCols.length + 3}, ''))`,
          [...setCols.map(c => r[c]), r.naam, r.leverancier, r.eenheid]
        );
      }
    }
    await client.query('commit');
  } catch (e) {
    try { await client.query('rollback'); } catch {}
    throw e;
  } finally {
    await client.end();
  }
  if (dubbelNamen.length) {
    console.warn(`[mirror] ${dubbelNamen.length} echte Notion-dubbel(en) (zelfde naam+leverancier+eenheid, andere pagina) samengevoegd i.p.v. dubbel opgeslagen — controleer in Notion: ${dubbelNamen.slice(0, 10).join(', ')}`);
  }
}

// --- Fuzzy match helpers ---
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => Array.from({ length: n + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}

function nameSimilarity(a, b) {
  const na = a.toLowerCase().trim(), nb = b.toLowerCase().trim();
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(na, nb) / maxLen;
}

// Token-Jaccard: beter voor dedup op langere namen met gewicht/verpakking in de naam
function tokenJaccard(a, b) {
  const tokens = s => new Set(s.toLowerCase().trim().split(/[\s,.()\-\/]+/).filter(t => t.length > 1));
  const ta = tokens(a), tb = tokens(b);
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = new Set([...ta, ...tb]).size;
  return union === 0 ? 1 : inter / union;
}

function findFuzzyMatch(naam, existing, threshold = 0.80) {
  let best = null, bestScore = 0;
  for (const e of existing) {
    let score = nameSimilarity(naam, e.name);
    if (score > bestScore) { bestScore = score; best = e; }
    for (const alias of (e.aliassen || [])) {
      score = nameSimilarity(naam, alias);
      if (score > bestScore) { bestScore = score; best = e; }
    }
  }
  return bestScore >= threshold ? { match: best, score: bestScore } : null;
}

// Dedup-check: >90% token-Jaccard + zelfde leverancier + zelfde prijs (±1%)
// Geeft de bestaande match terug als het een duidelijke duplicaat is.
function findDedupMatch(naam, price, leverancier, existing) {
  const THRESHOLD = 0.90;
  let best = null, bestScore = 0;
  for (const e of existing) {
    const score = Math.max(tokenJaccard(naam, e.name), nameSimilarity(naam, e.name));
    if (score < THRESHOLD) continue;

    const levGelijk = (leverancier || '').toLowerCase().trim() === (e.leverancier || '').toLowerCase().trim();
    const prijsGelijk = e.price !== null && price !== null
      && Math.abs(e.price - price) / Math.max(e.price, price, 0.01) < 0.01;

    if (levGelijk && prijsGelijk && score > bestScore) {
      bestScore = score;
      best = e;
    }
  }
  return best ? { match: best, score: bestScore } : null;
}

// --- Claude Haiku canonical matching ---
// Vraag Haiku: welke bestaande canonical past bij dit scan-product?
// Geeft { canonical, pageId, confidence (0-100), uitleg } of null als <30%.
async function matchCanonicalViaHaiku(item, existing, anthropicKey) {
  if (!anthropicKey || !existing || !existing.length) return null;

  // Bouw canonicalslijst: unieke canonical_naam waarden met hun paginacontext
  const canonicalMap = new Map(); // canonical → {pageId, leverancier, price, eenheid, name}
  for (const e of existing) {
    const cn = (e.canonical_naam || e.name || '').toLowerCase().trim();
    if (!cn || canonicalMap.has(cn)) continue;
    canonicalMap.set(cn, { pageId: e.pageId, leverancier: e.leverancier, price: e.price, eenheid: e.eenheid, name: e.name });
  }
  if (!canonicalMap.size) return null;

  const canonicals = [...canonicalMap.keys()];
  const scanContext = [
    `naam: ${item.ingredient}`,
    item.leverancier ? `leverancier: ${item.leverancier}` : null,
    item.price != null ? `prijs: €${item.price}${item.eenheid ? `/${item.eenheid}` : ''}` : null,
    item.omschrijving ? `omschrijving: ${item.omschrijving}` : null,
    item.inkoopeenheid ? `verpakking: ${item.inkoopeenheid}` : null,
  ].filter(Boolean).join(', ');

  const prompt = `Je bent een ingredient-koppelingsassistent voor een restaurant inkoopsysteem.

Scan-product: ${scanContext}

Bestaande restaurant-canonicals (schone restaurantnamen):
${canonicals.map((c, i) => `${i + 1}. ${c}`).join('\n')}

Taak: bepaal of dit scan-product overeenkomt met één van de bestaande canonicals.
Geef terug als JSON object:
{
  "canonical": "<exacte canonical naam uit de lijst, of null als geen match>",
  "confidence": <0-100, hoe zeker je bent>,
  "uitleg": "<één zin waarom dit product matcht of niet>"
}

Regels:
- confidence 95+ = vrijwel zeker hetzelfde product (bijv. "Freiland eieren scharrel" → "eieren")
- confidence 70-94 = waarschijnlijk hetzelfde maar twijfelachtig (bijv. "biologische verse spinazie" → "spinazie")
- confidence <70 = geen goede match, zet canonical op null
- Match NOOIT producten die duidelijk anders zijn (varkensvlees ≠ rund, mozzarella ≠ burrata)
- Kijk naar de kern van het product, niet naar merk/leverancier/verpakking/kwaliteitsklasse

Retourneer ALLEEN het JSON object, geen markdown, geen uitleg.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const data = await response.json();
    if (data.error) throw new Error(data.error.message);
    const raw = (data.content?.[0]?.text || '').replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.confidence !== 'number') return null;
    if (!parsed.canonical || parsed.confidence < 30) return null;

    const cn = (parsed.canonical || '').toLowerCase().trim();
    const entry = canonicalMap.get(cn);
    if (!entry) return null;

    return { canonical: cn, pageId: entry.pageId, name: entry.name, confidence: parsed.confidence, uitleg: parsed.uitleg || '' };
  } catch (e) {
    console.warn('[matchCanonical] Haiku fout:', e.message);
    return null;
  }
}

// --- Claude Haiku classificatie ---
async function classifyBatch(products, anthropicKey) {
  const names = products.map(p => p.ingredient.toLowerCase().trim());
  const prompt = `Je classificeert ingrediënten voor een restaurant inkoopbot.

Geef voor elk product:
- original: exact de ingevoerde naam
- simple_name: korte Nederlandse naam, lowercase (bijv "tomaat", "kippendij", "parmezaan reggiano")
- is_drank: true als het een drank/drankverwant product is (water, wijn, bier, frisdrank, sap, koffie, thee, etc), anders false. UITZONDERING: producten die "azijn" bevatten (wijnazijn, champagne azijn, balsamico azijn, etc.) zijn altijd is_drank: false, categorie: droogwaren.
- categorie: één van: zuivel | vlees | vis | groenten | droogwaren | specerijen | drank. Kies "specerijen" voor kruiden/specerijen (peper, zout, tijm, basilicum, kaneel, etc.), "groenten" voor verse groenten/fruit, "zuivel" voor melk/kaas/room/boter/eieren, "vlees" voor vlees/gevogelte, "vis" voor vis/schaal-/schelpdieren, "droogwaren" voor houdbare/droge producten (pasta, meel, olie, conserven), "drank" alleen voor dranken. Gebruik "droogwaren" alleen als geen andere categorie past.

Retourneer ALLEEN een JSON array, geen markdown, geen uitleg.

Producten:
${names.map((n, i) => `${i + 1}. ${n}`).join('\n')}`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': anthropicKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'prompt-caching-2024-07-31'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  const raw = (data.content?.[0]?.text || '').replace(/```json|```/g, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`classifyBatch: JSON.parse mislukt — ${e.message}. Response: ${raw.substring(0, 200)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`classifyBatch: verwacht array, kreeg ${typeof parsed}`);
  }
  return parsed;
}

// ── Filters: geblokkeerde leveranciers + non-food ────────────────────────────

// Leveranciers waarvan ALLE producten geweerd worden — nooit in Inkoop Prijzen.
const GEBLOKKEERDE_LEVERANCIERS = ['hsn'];
function isGeblokkeerdeLeverancier(leverancier) {
  const l = (leverancier || '').toLowerCase();
  return GEBLOKKEERDE_LEVERANCIERS.some(b => new RegExp(`\\b${b}\\b`).test(l));
}

// Non-food producten (vooral Sligro): schoonmaak/poets, verpakking, horeca supplies.
// Bot slaat deze over bij classificatie — ze horen nooit als ingredient in Notion.
const NON_FOOD_BLACKLIST = [
  // schoonmaak / poets
  'schoonmaak', 'reiniger', 'reinigings', 'ontkalk', 'ontvetter', 'allesreiniger', 'vaatwas', 'afwasmiddel',
  'glansspoel', 'spoelglans', 'handzeep', 'zeep', 'desinfect', 'bleekmiddel', 'bleekwater', 'chloor', 'wc-',
  'toiletpapier', 'toiletrol', 'poetsdoek', 'poetsrol', 'poetsmiddel', 'schuurmiddel', 'schuurspons', 'spons', 'dweil',
  'vuilniszak', 'afvalzak', 'keukenrol', 'vetvrij papier', 'sopdoek', 'microvezel',
  // verpakking
  'verpakking', 'deksel', 'rietje', 'servet', 'aluminiumfolie', 'vershoudfolie',
  'huishoudfolie', 'plasticfolie', 'draagtas', 'papieren zak', 'bestekzakje', 'meeneembox', 'to go', 'to-go',
  'takeaway', 'foambak', 'styrofoam', 'plastic zak', 'vacuumzak', 'vacuümzak', 'karton', 'cateringbox',
  // horeca supplies / non-food
  'kaars', 'waxine', 'tandenstoker', 'cocktailprikker', 'onderzetter', 'placemat', 'menukaart', 'krijtbord',
  'handschoen', 'haarnet', 'schort', 'vaatdoek', 'theedoek', 'batterij', 'gloeilamp', 'bonrol', 'kassarol',
  // EHBO / medisch / hygiëne (geen ingredient)
  'detectaplast', 'pleister', 'vingerpleister', 'wondpleister', 'ehbo', 'verbandtrommel', 'verbandmiddel',
  'mondkapje', 'mondmasker', 'desinfectiegel', 'handgel', 'wondspray', 'kompres', 'blauwe pleister',
];
// Match op WOORDGRENS-start: "folie" matcht niet in "olijfolie", maar plurals/
// samenstellingen mét het woord als basis (sopdoeken, vuilniszakken) wél.
function isNonFood(naam) {
  const n = (naam || '').toLowerCase();
  return NON_FOOD_BLACKLIST.some(term => {
    const re = new RegExp('\\b' + term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return re.test(n);
  });
}

// Drank-blacklist: termen die een product altijd als drank markeren.
// Diacriet-ongevoelig, op hele-woord match zodat "cru" niet matcht in "crudités"
// en "cola" niet in "chocola".
const DRANK_BLACKLIST = [
  // Franse wijntermen
  'vins', 'pirouettes', 'cuvée', 'château', 'domaine', 'cépage',
  'millésime', 'cave', 'vignoble', 'cru',
  // Frisdrank / energie / softdrinks — horen nooit in Inkoop Prijzen
  'cola', 'cola zero', 'coca cola', 'coca-cola', 'pepsi', 'fanta', 'sprite',
  '7up', 'seven up', 'ice tea', 'icetea', 'ijsthee', 'tonic', 'bitter lemon',
  'ginger beer', 'ginger ale', 'red bull', 'redbull', 'monster', 'energy drink',
  'frisdrank', 'soda', 'limonade',
];
function stripAccents(s) {
  return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}
function isDrank(naam) {
  const n = stripAccents((naam || '').toLowerCase());
  return DRANK_BLACKLIST.some(term => new RegExp(`\\b${stripAccents(term)}\\b`).test(n));
}

// ── Datum-varianten in productnamen ──────────────────────────────────────────
// Eén factuur (bijv. Asperges Amsterdam) kan hetzelfde product op meerdere
// leverdatums bevatten: "asperges aa ongeschild 2-6", "asperges aa ongeschild 5-6".
// Dat is hetzelfde ingredient op verschillende datums.

// Strip een achtervoegsel-datum (d-m, d-m-jj, dd/mm) → basisnaam.
function stripDatum(naam) {
  return String(naam || '').replace(/\s+\d{1,2}[-/]\d{1,2}(?:[-/]\d{2,4})?\s*$/i, '').trim();
}

// Lees de datum uit het naam-achtervoegsel → ISO (YYYY-MM-DD), of null. Formaat
// d-m (Nederlands: "2-6" = 2 juni); jaartal valt terug op het huidige jaar.
function parseDatumUitNaam(naam) {
  const m = String(naam || '').match(/(\d{1,2})[-/](\d{1,2})(?:[-/](\d{2,4}))?\s*$/);
  if (!m) return null;
  const dag = parseInt(m[1], 10), maand = parseInt(m[2], 10);
  if (dag < 1 || dag > 31 || maand < 1 || maand > 12) return null;
  let jaar = m[3] ? parseInt(m[3], 10) : new Date().getFullYear();
  if (jaar < 100) jaar += 2000;
  const pad = n => String(n).padStart(2, '0');
  return `${jaar}-${pad(maand)}-${pad(dag)}`;
}

// Lees de sorterings-/kwaliteitsklasse uit (alleen voor asperges): "aa"/"aaa"/
// "aaaa". Dit IS een apart product (aa ≠ aaa), dus de klasse blijft in de naam
// staan — we geven hem alleen óók als los veld terug zodat hij in raw data kan.
function normaliseerKwaliteit(naam) {
  const n = String(naam || '');
  const base = n.trim();
  if (!/asperge/i.test(n)) return { base, klasse: '' };
  const m = n.match(/\b(a{2,4})\b/i); // standalone aa/aaa/aaaa
  return { base, klasse: m ? m[1].toUpperCase() : '' };
}

// Voeg datum-varianten samen. Retourneert:
//  - hoofdItems:    één item per basisnaam, met de prijs van de MEEST RECENTE datum
//                   (voor de Inkoop Prijzen entry — géén losse entry per datum).
//  - historieItems: élke variant met basisnaam + eigen datum (voor de Inkoop
//                   Geschiedenis — aparte stippen in de prijsgrafiek).
// Strip ook de datum (stripDatum) én de asperges-kwaliteitsklasse (normaliseerKwaliteit).
function collapseDatumVarianten(items) {
  const vandaag = new Date().toISOString().split('T')[0];
  const historieItems = (items || []).map(it => {
    const { base, klasse } = normaliseerKwaliteit(stripDatum(it.ingredient));
    // Structurele prijs-eenheid regel: normaliseer naar prijs per kg (kistprijs
    // ÷ kg-inhoud) vóór opslag/vergelijking — geldt voor headless én syncAll.
    return normaliseerPrijsPerKg({
      ...it,
      ingredient: base,
      kwaliteitsklasse: klasse || it.kwaliteitsklasse || '',
      datum: parseDatumUitNaam(it.ingredient) || vandaag,
    });
  });
  const perBasis = new Map();
  for (const it of historieItems) {
    const key = it.ingredient.toLowerCase().trim();
    const cur = perBasis.get(key);
    if (!cur || it.datum >= cur.datum) perBasis.set(key, it); // laatste datum = hoofdprijs
  }
  return { hoofdItems: [...perBasis.values()], historieItems };
}

// Bouw de volledige raw-data regel uit ALLES wat de leverancier op de factuur
// meestuurt (alleen velden die de parser daadwerkelijk vond). Wordt naar de
// Notion `Raw data` property geschreven bij elke scan.
function bouwRawData(item) {
  if (!item) return '';
  const v = [];
  const add = (label, val) => { if (val != null && String(val).trim() !== '') v.push(`${label}: ${String(val).trim()}`); };
  add('leverancier', item.leverancier);
  add('e-mail', item.leverancier_email);
  add('artikelnr', item.artikelnummer);
  add('barcode', item.barcode);
  add('omschrijving', item.omschrijving);
  add('gewicht', item.gewicht);
  add('verpakking', item.verpakking);
  add('eenheid', item.eenheid);
  add('prijs', item.price != null ? `€ ${Number(item.price).toFixed(2)}${item.eenheid && /kg/i.test(item.eenheid) ? '/kg' : ''}` : null);
  // Originele factuurprijs per inkoopeenheid (vóór normalisatie naar prijs/kg)
  add('prijs per inkoopeenheid', item.prijs_origineel != null ? `€ ${Number(item.prijs_origineel).toFixed(2)}` : null);
  add('inhoud', item.gram_per_inkoopeenheid ? `${item.gram_per_inkoopeenheid} g` : null);
  add('btw', item.btw);
  add('factuurnr', item.factuurnummer);
  add('ordernr', item.ordernummer);
  add('herkomst', item.herkomst);
  add('kwaliteitsklasse', item.kwaliteitsklasse);
  add('temperatuur', item.temperatuur);
  add('min. bestelling', item.min_bestelling);
  return v.join(' · ');
}

// Lees een inkoop-/verpakkingseenheid uit de productnaam, bijv.
// "spitskool bio, kist 9 st." → "kist 9 st", "slagroom, 1l" → "1l",
// "olijfolie ..., blik 5l" → "blik 5l", "kastanje champignon, 2kg" → "2kg".
function parseInkoopeenheid(naam) {
  const n = String(naam || '').trim();
  if (!n) return '';
  const verp = /(kist|krat|doos|dozen|bak|emmer|pak|pakken|zak|zakken|bos|bossen|tray|blik|fles|flacon|bus|rol|can|pot)/i;
  const hoev = /\d+\s*(?:[-/]\s*\d+)?\s*(?:kg|kilo|gram|gr|g|ml|liter|ltr|l|cl|st|stuks?|bossen?)\b/i;
  if (n.includes(',')) {
    const na = n.split(',').pop().trim().replace(/\.$/, '');
    if (na && (verp.test(na) || hoev.test(na))) return na;
  }
  const m = n.match(/((?:kist|krat|doos|bak|emmer|pak|zak|bos|tray|blik|fles|bus|rol|pot)\s*\d*\s*(?:kg|kilo|gram|gr|g|ml|liter|ltr|l|cl|st|stuks?|bossen?)?|\d+\s*(?:kg|kilo|gram|gr|g|ml|liter|ltr|l|cl|st|stuks?))\s*$/i);
  return m ? m[1].trim().replace(/\.$/, '') : '';
}

// Lees het GEWICHT in grammen uit een inkoopeenheid-tekst ("kist 5 kg" → 5000,
// "2kg" → 2000, "circa 100 gram" → 100, "1l" → 1000, "blik 5l" → 5000,
// "bulk 5/6 kg" → 5500 [gemiddelde]). Stuks-eenheden ("kist 9 st") → null.
function parseGramPerInkoopeenheid(tekst) {
  const t = String(tekst || '').toLowerCase();
  if (!t) return null;
  if (/\d\s*(?:st|stk|stuks?|bossen?|bos)\b/.test(t)) return null; // stuks, geen gewicht
  const m = t.match(/(\d+(?:[.,]\d+)?)\s*(?:[-/]\s*(\d+(?:[.,]\d+)?))?\s*(kg|kilo|gram|gr|g|ml|liter|ltr|l|cl)\b/);
  if (!m) return null;
  const num = (s) => parseFloat(String(s).replace(',', '.'));
  let v = num(m[1]);
  if (m[2]) v = (v + num(m[2])) / 2; // bereik "5/6 kg" → gemiddelde
  const unit = m[3];
  if (/^(kg|kilo)$/.test(unit)) return Math.round(v * 1000);
  if (/^(l|liter|ltr)$/.test(unit)) return Math.round(v * 1000); // 1l ≈ 1kg
  if (/^cl$/.test(unit)) return Math.round(v * 10);
  if (/^ml$/.test(unit)) return Math.round(v);
  return Math.round(v); // gram/gr/g
}

// Normaliseer een scan-item naar PRIJS PER KG (structurele prijs-eenheid regel:
// Kostprijs in Inkoop Prijzen is altijd per kg of per stuk). Als de factuurregel
// een prijs per inkoopeenheid geeft (€ 44,25 per kist 5 kg) en het gewicht is
// parsebaar → price = 44,25 ÷ 5 = 8,85/kg, eenheid 'kg', gram_per_inkoopeenheid
// 5000, en de originele prijs blijft in prijs_origineel (→ raw data). Regels die
// al per kg geprijsd zijn blijven ongemoeid; stuks-eenheden ook (stuksprijs-flow).
function normaliseerPrijsPerKg(item) {
  if (!item || item.price == null) return item;
  if (/\b(kg|kilo)\b/i.test(item.eenheid || '')) {
    // Al per kg — alleen het gewicht van de inkoopeenheid als metadata bewaren
    const g = parseGramPerInkoopeenheid(item.inkoopeenheid || parseInkoopeenheid(item.ingredient) || item.gewicht || item.verpakking);
    return g ? { ...item, gram_per_inkoopeenheid: g } : item;
  }
  const bron = item.inkoopeenheid || parseInkoopeenheid(item.ingredient) || item.gewicht || item.verpakking;
  const gram = parseGramPerInkoopeenheid(bron);
  if (!gram || gram < 10) return item; // niets parsebaars (of ruis) → laat staan
  // Alleen naar prijs/kg omrekenen bij een BULK-inkoopeenheid: een verpakkingswoord
  // (kist/doos/krat/bak/emmer/blik/bus/bulk/…) óf een hoeveelheid ≥ 1 kg/liter.
  // Kleine losse gewichten in de naam ("circa 70 gram", "100gr", "33cl") zijn een
  // portie-aanduiding van een per-stuk/bos product → niet omrekenen. Voorkomt valse
  // per-kg alerts zoals "tijm, circa 70 gram" €1,27 → €18,14/kg (+1328%).
  const heeftVerpakking = /\b(kist|krat|doos|dozen|bak|emmer|blik|bus|can|bulk|pak|pakken|zak|zakken|tray|fles|flacon|pot|rol)\b/i.test(String(bron));
  if (!heeftVerpakking && gram < 1000) return item;
  return {
    ...item,
    prijs_origineel: item.price,
    price: Math.round((item.price / (gram / 1000)) * 100) / 100,
    eenheid: 'kg',
    gram_per_inkoopeenheid: gram,
  };
}

// Filter scan-items vóór verwerking: HSN-leverancier, non-food, en de lerende
// blacklist (uit Supabase non_food_blacklist). Retourneert { kept, blocked }.
function filterScanItems(items, learnedBlacklist = []) {
  const learnedSet = new Set((learnedBlacklist || []).map(s => (s || '').toLowerCase().trim()).filter(Boolean));
  const kept = [];
  const blocked = { hsn: [], nonFood: [], drank: [], learned: [] };
  for (const item of items) {
    const naam = (item.ingredient || '').toLowerCase().trim();
    if (isGeblokkeerdeLeverancier(item.leverancier)) { blocked.hsn.push(naam); continue; }
    if (isNonFood(naam)) { blocked.nonFood.push(naam); continue; }
    if (isDrank(naam)) { blocked.drank.push(naam); continue; } // frisdrank/wijn → nooit in Inkoop Prijzen
    if (learnedSet.has(naam)) { blocked.learned.push(naam); continue; }
    kept.push(item);
  }
  return { kept, blocked };
}

class NotionSync {
  constructor(settings) {
    this.client = new Client({ auth: (settings.notionToken || '').trim() });
    this.dbId = (settings.notionDbId || '').trim();
    this.historyDbId = '2d313fcc4d2f480c84ee3344a70cbdcb';
    this.anthropicKey = settings.anthropicKey;
  }

  async getAllPrices() {
    const results = [];
    let cursor;
    do {
      const r = await this.client.databases.query({ database_id: this.dbId, start_cursor: cursor, page_size: 100 });
      for (const page of r.results) {
        const props = page.properties;
        const name = props['Ingredient']?.title?.[0]?.plain_text || '';
        if (!name) continue;
        const aliasRaw = props['Aliassen']?.rich_text?.[0]?.plain_text || '';
        const canonical = props['Canonical naam']?.rich_text?.[0]?.plain_text || '';
        results.push({
          pageId: page.id,
          name: name.toLowerCase().trim(),
          canonical_naam: (canonical || name).toLowerCase().trim(),
          price: props['Kostprijs']?.number ?? null,
          eenheid: props['Eenheid']?.rich_text?.[0]?.plain_text || 'kg',
          leverancier: props['Leverancier']?.rich_text?.[0]?.plain_text || '',
          aliassen: aliasRaw ? aliasRaw.split(',').map(a => a.trim().toLowerCase()).filter(Boolean) : [],
          isDrank: props['Is drank']?.checkbox || false,
          categorie: props['Categorie']?.select?.name || '',
          rawData: props['Raw data']?.rich_text?.[0]?.plain_text || '',
          laatsteUpdate: props['Laatste update']?.last_edited_time || page.last_edited_time || '',
        });
      }
      cursor = r.has_more ? r.next_cursor : undefined;
    } while (cursor);
    return results;
  }

  // Classificeer producten (simple_name / is_drank / categorie) via Claude Haiku,
  // in batches van 20 zodat het antwoord niet afgekapt wordt. Een mislukte batch
  // levert simpelweg geen classificatie → die producten vallen terug op 'droogwaren'.
  async classify(items) {
    if (!items || !items.length || !this.anthropicKey) return [];
    const out = [];
    for (let i = 0; i < items.length; i += 20) {
      try { out.push(...await classifyBatch(items.slice(i, i + 20), this.anthropicKey)); }
      catch (e) { console.warn('[classify] batch fout:', e.message); }
    }
    return out;
  }

  // Detecteer mogelijke dubbelen: ingrediënten die sterk op elkaar lijken
  // (fuzzy >85%) én dezelfde leverancier hebben. Schrijft per nieuw paar een
  // `mogelijk_dubbel` melding naar Supabase scan_meldingen (dedup op naam-paar).
  async detecteerDubbels(supabase, blacklist = []) {
    if (!supabase) return { count: 0 };
    const prices = await this.getAllPrices();
    // Geblacklistte (non-food) producten genereren geen mutatiemeldingen.
    const blacklistSet = new Set((blacklist || []).map(s => (s || '').toLowerCase().trim()).filter(Boolean));
    let bestaande = [];
    try {
      const { data } = await supabase.from('scan_meldingen').select('ingredient_naam, scan_naam').eq('type', 'mogelijk_dubbel');
      bestaande = data || [];
    } catch {}
    const gezien = new Set(bestaande.map(m => [m.ingredient_naam, m.scan_naam].sort().join('::')));
    const meldingen = [];
    for (let i = 0; i < prices.length; i++) {
      for (let j = i + 1; j < prices.length; j++) {
        const a = prices[i], b = prices[j];
        // Sla paren over waarvan één kant op de blacklist staat — geen melding.
        if (blacklistSet.has((a.name || '').toLowerCase().trim()) ||
            blacklistSet.has((b.name || '').toLowerCase().trim())) continue;
        const levA = (a.leverancier || '').toLowerCase().trim();
        const levB = (b.leverancier || '').toLowerCase().trim();
        if (!levA || levA !== levB) continue; // zelfde leverancier vereist
        // aa vs aaa = aparte kwaliteitsklasse, géén dubbel: verschillen de namen
        // alléén in de standalone grade (a{2,4}), sla het paar over.
        const gradeA = (a.name.match(/\b(a{2,4})\b/i) || [])[1] || '';
        const gradeB = (b.name.match(/\b(a{2,4})\b/i) || [])[1] || '';
        const stripGrade = (s) => String(s).replace(/\b(a{2,4})\b/i, ' ').replace(/\s{2,}/g, ' ').trim().toLowerCase();
        if ((gradeA || gradeB) && gradeA.toLowerCase() !== gradeB.toLowerCase() && stripGrade(a.name) === stripGrade(b.name)) continue;
        const score = Math.max(tokenJaccard(a.name, b.name), nameSimilarity(a.name, b.name));
        if (score <= 0.85) continue;
        const key = [a.name, b.name].sort().join('::');
        if (gezien.has(key)) continue;
        gezien.add(key);
        // Doel = het product met (de meest betrouwbare) prijs; bron = de ander.
        const target = a.price != null ? a : (b.price != null ? b : a);
        const source = target === a ? b : a;
        meldingen.push({
          type: 'mogelijk_dubbel',
          ingredient_naam: source.name,
          scan_naam: target.name,
          leverancier: a.leverancier || '',
          wijziging_pct: Math.round(score * 100), // match-% voor de melding
          bestaand_page_id: target.pageId,
          status: 'pending',
          gelezen: false,
        });
      }
    }
    if (meldingen.length) {
      const { error } = await supabase.from('scan_meldingen').insert(meldingen);
      if (error) console.warn('[dubbel] insert fout:', error.message);
    }
    return { count: meldingen.length };
  }

  // Intelligente AUTO-MERGE van overduidelijke dubbelen — zónder melding, gewoon
  // doen. Draait bij elke scan over het HELE assortiment (vergelijkt alle actieve
  // ingrediënten paarsgewijs). Auto-merge vereist ALTIJD een NAAM- of ARTIKELNR-
  // relatie + dezelfde leverancier — een toevallig gelijke prijs alléén voegt nooit
  // ongerelateerde namen samen.
  //   A) naam fuzzy match >90% (token-Jaccard / similarity)              → merge
  //   B) generiek ⊂ specifiek: de korte naam is een betekenisvolle-token-
  //      subset van de lange én ze eindigen op hetzelfde hoofdwoord
  //      ("eieren" ⊂ "dagverse freiland eieren", "kropsla" ⊂ "kropsla bio"),
  //      bevestigd door zelfde prijs OF fuzzy >78%                        → merge
  //   C) zelfde leverancier + zelfde ARTIKELNR (uit raw_data)             → merge
  //      Het artikelnr is de échte identiteit bij de leverancier: als de AI-parser
  //      de naam nét anders leest ("kers"/"kersen ontpit", "kruisbes"/"kruisbes
  //      rood"), ontstond er een tweede rij voor hetzelfde product — de wortel
  //      onder alle wisselende-prijs-gevallen (kruisbes had 3 prijzen, oester 2).
  // aa/aaa-grades worden nooit samengevoegd (behalve bij zelfde artikelnr — dan
  // is het per definitie hetzelfde product). Groepen via union-find (3+ samen).
  // Per groep: langste/meest beschrijvende naam = hoofd, de rest worden aliassen;
  // meest recente prijs blijft; prijshistorie gecombineerd; raw_data geërfd;
  // bronnen gearchiveerd; merge gelogd in de Inkoop Geschiedenis (Source-veld).
  // `supabase` (optioneel): verhuist verwijzingen (bereiding_component.ingredient_id,
  // ingredient_concept.voorkeur_prijs_id) van bron → hoofd, zodat recepturen nooit
  // een wees-ingrediënt overhouden wanneer de mirror de bron-rij opruimt.
  async autoMerge(supabase = null) {
    const prices = await this.getAllPrices();
    const n = prices.length;
    const parent = prices.map((_, i) => i);
    const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };

    // Stopwoorden + kwalificaties + verpakkings-/maat-tokens negeren we bij de
    // naam-relatie, zodat alleen de eigenlijke productwoorden tellen.
    const STOP = new Set(['bio','vers','verse','dagverse','circa','de','het','een','van','met','st','stk','stuks','kg','gr','gram','kist','doos','bak','bakje','krat','blik','pak','zak','bos','bol','emmer','bulk','fr','nl','it','es','gangbaar','diversen','stuksartikel','glas']);
    const tokens = (s) => String(s).toLowerCase().split(/[\s,.()\-\/]+/).filter(t => t.length > 1);
    // Betekenisvolle tokens: geen stopwoord en niet beginnend met een cijfer
    // (maten als "1l", "20cl", "5kg", "12-14", "70" tellen niet mee).
    const sig = (s) => tokens(s).filter(t => !STOP.has(t) && !/^\d/.test(t));
    const head = (arr) => arr.length ? arr[arr.length - 1] : '';
    const stripGrade = (s) => String(s).replace(/\b(a{2,4})\b/i, ' ').replace(/\s{2,}/g, ' ').trim().toLowerCase();
    const grade = (s) => ((String(s).match(/\b(a{2,4})\b/i) || [])[1] || '').toLowerCase();
    const isSubset = (kort, lang) => kort.length > 0 && kort.every(t => lang.includes(t));

    const redenen = {}; // root-index → set van redenen (voor de log)
    const noteer = (i, r) => { const k = find(i); (redenen[k] = redenen[k] || new Set()).add(r); };
    // Artikelnr uit de raw_data-tekst ("artikelnr: 60916") — de identiteit bij de leverancier.
    const artikelnrVan = (p) => (p.rawData || '').match(/artikelnr:\s*([^\s·]+)/i)?.[1] || null;

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = prices[i], b = prices[j];
        const levA = (a.leverancier || '').toLowerCase().trim();
        const levB = (b.leverancier || '').toLowerCase().trim();
        if (!levA || levA !== levB) continue; // zelfde leverancier vereist
        // C) Zelfde artikelnr bij dezelfde leverancier = per definitie hetzelfde product,
        //    ongeacht hoe de naam geparsed werd. Sterkste bewijs — gaat vóór de grade-uitsluiting.
        const artA = artikelnrVan(a), artB = artikelnrVan(b);
        if (artA && artA === artB) { union(i, j); noteer(i, `zelfde artikelnr ${artA}`); continue; }
        // aa vs aaa = aparte kwaliteitsklasse → nooit auto-mergen
        const gA = grade(a.name), gB = grade(b.name);
        if ((gA || gB) && gA !== gB && stripGrade(a.name) === stripGrade(b.name)) continue;

        const sa = sig(a.name), sb = sig(b.name);
        const zelfdePrijs = a.price != null && b.price != null && Math.abs(a.price - b.price) < 0.005;
        const score = Math.max(tokenJaccard(a.name, b.name), nameSimilarity(a.name, b.name));
        // Generiek ⊂ specifiek + zelfde hoofdwoord (laatste betekenisvolle token)
        const overlap = sa.length && sb.length && head(sa) === head(sb) && (isSubset(sa, sb) || isSubset(sb, sa));
        let reden = '';
        if (score > 0.90) reden = `naam ${Math.round(score * 100)}% match`;
        else if (overlap && (zelfdePrijs || score > 0.78)) {
          reden = zelfdePrijs ? 'naam-overlap + zelfde prijs' : 'sterke naam-overlap';
        }
        if (!reden) continue;
        union(i, j);
        noteer(i, reden);
      }
    }

    // Groepeer per union-find root
    const groepen = new Map();
    for (let i = 0; i < n; i++) { const r = find(i); if (!groepen.has(r)) groepen.set(r, []); groepen.get(r).push(i); }

    let merged = 0;
    for (const [root, idxs] of groepen) {
      if (idxs.length < 2) continue;
      const leden = idxs.map(i => prices[i]);
      // Hoofd = langste (meest beschrijvende) naam; tie-break: meeste tokens
      leden.sort((x, y) => y.name.length - x.name.length || tokens(y.name).length - tokens(x.name).length);
      const hoofd = leden[0];
      const bronnen = leden.slice(1);
      // Meest recente prijs (op Laatste update); val terug op hoofd
      const metPrijs = leden.filter(m => m.price != null).sort((x, y) => String(y.laatsteUpdate).localeCompare(String(x.laatsteUpdate)));
      const prijsBron = metPrijs[0] || hoofd;
      // Aliassen samenvoegen (bron-namen + alle aliassen, zonder de hoofd-naam)
      const aliasSet = new Set([...(hoofd.aliassen || [])]);
      for (const b of bronnen) { aliasSet.add(b.name); for (const al of (b.aliassen || [])) aliasSet.add(al); }
      aliasSet.delete(hoofd.name);
      // Raw data erven als het hoofd er nog geen heeft maar een lid wel
      const hoofdHeeftRaw = !!(hoofd.rawData && hoofd.rawData.trim());
      let raw = hoofd.rawData;
      if (!hoofdHeeftRaw) { const metRaw = leden.find(m => m.rawData && m.rawData.trim()); if (metRaw) raw = metRaw.rawData; }

      const props = { 'Aliassen': { rich_text: [{ text: { content: [...aliasSet].join(', ').slice(0, 1999) } }] } };
      if (prijsBron.price != null) {
        props['Kostprijs'] = { number: prijsBron.price };
        if ((prijsBron.leverancier || '').trim()) props['Leverancier'] = { rich_text: [{ text: { content: prijsBron.leverancier } }] };
      }
      if (raw && !hoofdHeeftRaw) props['Raw data'] = { rich_text: [{ text: { content: raw.slice(0, 1999) } }] };

      try {
        await this.client.pages.update({ page_id: hoofd.pageId, properties: props });
        for (const b of bronnen) {
          await this.hernoemHistorie(b.name, hoofd.name);
          // Verwijzingen in Supabase omhangen VÓÓR het archiveren: recepturen
          // (bereiding_component) en concept-voorkeuren die naar de bron-rij wijzen
          // gaan naar het hoofd — anders houdt de mirror-opruiming ze als wees vast
          // (de FK blokkeert verwijderen) of verliest een recept zijn prijs.
          if (supabase) {
            try {
              await supabase.from('bereiding_component').update({ ingredient_id: hoofd.pageId }).eq('ingredient_id', b.pageId);
              await supabase.from('ingredient_concept').update({ voorkeur_prijs_id: hoofd.pageId }).eq('voorkeur_prijs_id', b.pageId);
            } catch (e2) { console.warn(`[auto-merge] verwijzing omhangen (${b.name}): ${e2.message}`); }
          }
          await this.client.pages.update({ page_id: b.pageId, archived: true });
        }
        const reden = [...(redenen[root] || ['dubbel'])].join(', ');
        await this.logMerge(hoofd, bronnen.map(b => b.name), prijsBron.price, reden);
        console.log(`  🔀 AUTO-MERGE: "${hoofd.name}" ← ${bronnen.map(b => `"${b.name}"`).join(', ')} (${reden})`);
        merged += bronnen.length;
      } catch (e) {
        console.warn(`[auto-merge] fout bij "${hoofd.name}": ${e.message}`);
      }
    }
    return { merged };
  }

  // Hernoem alle Inkoop Geschiedenis-rijen van een bron-naam naar de doel-naam
  // (gecombineerde prijsgrafiek na een merge).
  async hernoemHistorie(vanNaam, naarNaam) {
    let cursor;
    do {
      const r = await this.client.databases.query({
        database_id: this.historyDbId, start_cursor: cursor, page_size: 100,
        filter: { property: 'Ingredient', title: { equals: vanNaam } },
      });
      for (const h of r.results) {
        try { await this.client.pages.update({ page_id: h.id, properties: { 'Ingredient': { title: [{ text: { content: naarNaam } }] } } }); } catch {}
      }
      cursor = r.has_more ? r.next_cursor : undefined;
    } while (cursor);
  }

  // Log een merge als rij in de Inkoop Geschiedenis (Source-veld = beschrijving),
  // zodat hij in de activiteitslog van het ingredient verschijnt.
  async logMerge(hoofd, bronNamen, prijs, reden) {
    const vandaag = new Date().toISOString().split('T')[0];
    try {
      await this.client.pages.create({
        parent: { database_id: this.historyDbId },
        properties: {
          'Ingredient': { title: [{ text: { content: hoofd.name } }] },
          ...(prijs != null ? { 'Prijs': { number: prijs } } : {}),
          'Leverancier': { rich_text: [{ text: { content: hoofd.leverancier || '' } }] },
          'Datum': { date: { start: vandaag } },
          'Source': { rich_text: [{ text: { content: `Automatisch samengevoegd met ${bronNamen.map(b => `"${b}"`).join(', ')} (${reden})`.slice(0, 1999) } }] },
        },
      });
    } catch (e) { console.warn('[auto-merge] log fout:', e.message); }
  }

  // Spiegel ALLE (niet-gearchiveerde) Notion-ingrediënten naar Supabase
  // `inkoop_prijzen`. Notion blijft bron van waarheid; Supabase is de read-cache
  // voor /api/ingredienten. Rijen die niet meer in Notion staan worden verwijderd.
  async mirrorNaarSupabase(supabase) {
    if (!supabase) return { skipped: true };
    const runTs = new Date().toISOString();
    const rows = [];
    let cursor;
    do {
      const r = await this.client.databases.query({ database_id: this.dbId, start_cursor: cursor, page_size: 100 });
      for (const page of r.results) {
        if (page.archived) continue;
        const props = page.properties;
        const naam = props['Ingredient']?.title?.[0]?.plain_text || '';
        if (!naam) continue;
        const variantRaw = props['Variant']?.rich_text?.[0]?.plain_text || '';
        const yieldMatch = variantRaw.match(/yield:(\d+)(gram|stuk|ml)/);
        const seizoenMatch = variantRaw.match(/seizoen:(.+?)(?:\n|$)/);
        const details_variant = variantRaw.replace(/yield:\d+(?:gram|stuk|ml)\n?/, '').replace(/seizoen:.+?(?:\n|$)/, '').trim();
        rows.push({
          id: page.id,
          naam,
          canonical_naam: (props['Canonical naam']?.rich_text?.[0]?.plain_text || naam).toLowerCase().trim(),
          leverancier: props['Leverancier']?.rich_text?.[0]?.plain_text || '',
          kostprijs: props['Kostprijs']?.number ?? null,
          eenheid: props['Eenheid']?.rich_text?.[0]?.plain_text || '',
          inkoopeenheid: props['Inkoopeenheid']?.rich_text?.[0]?.plain_text || '',
          yield_pct: yieldMatch ? yieldMatch[1] : '',
          yield_eenheid: yieldMatch ? yieldMatch[2] : 'gram',
          categorie: props['Categorie']?.select?.name || '',
          aliassen: props['Aliassen']?.rich_text?.[0]?.plain_text || '',
          details_variant,
          seizoen: seizoenMatch ? seizoenMatch[1].trim() : '',
          is_drank: props['Is drank']?.checkbox || false,
          raw_data: props['Raw data']?.rich_text?.[0]?.plain_text || '',
          gram_per_inkoopeenheid: props['Gram per inkoopeenheid']?.number
            ?? parseGramPerInkoopeenheid(props['Inkoopeenheid']?.rich_text?.[0]?.plain_text || ''),
          laatste_update: props['Laatste update']?.last_edited_time || page.last_edited_time || null,
          updated_at: runTs,
        });
      }
      cursor = r.has_more ? r.next_cursor : undefined;
    } while (cursor);

    let zonderGram = false;      // fallback als de Supabase-kolom (nog) niet bestaat
    let zonderCanonical = false; // idem voor canonical_naam
    const strip = (b) => b.map(({ gram_per_inkoopeenheid, canonical_naam, ...r }) => ({
      ...r,
      ...(zonderGram ? {} : { gram_per_inkoopeenheid }),
      ...(zonderCanonical ? {} : { canonical_naam }),
    }));
    for (let i = 0; i < rows.length; i += 100) {
      const batch = rows.slice(i, i + 100);
      let { error } = await supabase.from('inkoop_prijzen').upsert(strip(batch), { onConflict: 'id' });
      // Als id-conflict mislukt (bijv. duplicaat op naam+lev+eenheid): fallback op de naam+leverancier+
      // eenheid-identiteit, via rechtstreekse SQL (zie upsertViaNaamLevEenheid hierboven).
      if (error && /unique/i.test(error.message)) {
        try {
          await upsertViaNaamLevEenheid(strip(batch));
          error = null;
        } catch (e) {
          error = { message: e.message };
        }
      }
      if (error && /gram_per_inkoopeenheid/i.test(error.message)) {
        zonderGram = true;
        console.warn('[mirror] kolom gram_per_inkoopeenheid ontbreekt — gespiegeld zonder dit veld. SQL: alter table inkoop_prijzen add column gram_per_inkoopeenheid numeric;');
        ({ error } = await supabase.from('inkoop_prijzen').upsert(strip(batch), { onConflict: 'id' }));
      }
      if (error && /canonical_naam/i.test(error.message)) {
        zonderCanonical = true;
        console.warn('[mirror] kolom canonical_naam ontbreekt — gespiegeld zonder dit veld. SQL: alter table inkoop_prijzen add column canonical_naam text;');
        ({ error } = await supabase.from('inkoop_prijzen').upsert(strip(batch), { onConflict: 'id' }));
      }
      if (error) { console.warn('[mirror] upsert fout:', error.message); return { error: error.message }; }
    }
    // Prune: alles wat deze run niet is bijgewerkt = niet meer in Notion → weg.
    // Maar: rijen die nog door een receptuur (bereiding_component) worden gebruikt mogen
    // NIET hard verdwijnen — de FK bereiding_component_ingredient_id_fkey blokkeert anders
    // het hele delete-statement (→ er werd voorheen helemaal niets geprund). Die houden we
    // vast; de rest verwijderen we wel.
    if (rows.length) {
      const { data: stale } = await supabase.from('inkoop_prijzen').select('id').lt('updated_at', runTs);
      const staleIds = (stale || []).map((r) => r.id);
      if (staleIds.length) {
        // Welke verouderde ids zijn nog in gebruik door een receptuur? Filter bereiding_component
        // op precies die (kleine) set — niet de hele tabel ophalen (PostgREST capt op 1000 rijen,
        // waardoor referenties voorbij rij 1000 gemist werden en de FK alsnog blokkeerde).
        const inGebruik = new Set();
        for (let i = 0; i < staleIds.length; i += 100) {
          const { data: g } = await supabase
            .from('bereiding_component')
            .select('ingredient_id')
            .in('ingredient_id', staleIds.slice(i, i + 100));
          (g || []).forEach((r) => inGebruik.add(r.ingredient_id));
        }
        const teVerwijderen = staleIds.filter((id) => !inGebruik.has(id));
        let verwijderd = 0;
        for (let i = 0; i < teVerwijderen.length; i += 100) {
          const { error } = await supabase.from('inkoop_prijzen').delete().in('id', teVerwijderen.slice(i, i + 100));
          if (error) console.warn('[mirror] prune fout:', error.message);
          else verwijderd += Math.min(100, teVerwijderen.length - i);
        }
        if (verwijderd) console.log(`[mirror] ${verwijderd} verouderde rij(en) verwijderd (niet meer in Notion).`);
        if (inGebruik.size) console.log(`[mirror] ${inGebruik.size} verouderde rij(en) behouden — nog in gebruik door een receptuur.`);
      }
    }
    // Passard (zelflerend): hang nieuwe/ongekoppelde rijen aan hun canonieke concept.
    await this.koppelConcepten(supabase);
    return { count: rows.length };
  }

  // Koppel inkoop_prijzen-rijen zonder concept_id aan een ingredient_concept (canonical_naam).
  // Idempotent en tolerant: ontbreekt de concept-laag (vóór de migratie) → stil overslaan.
  async koppelConcepten(supabase) {
    const norm = (s) => (s || '').toLowerCase().trim();
    try {
      const { data: los, error } = await supabase
        .from('inkoop_prijzen').select('id, naam, canonical_naam').is('concept_id', null);
      if (error) { if (!/concept_id/i.test(error.message)) console.warn('[concept] select fout:', error.message); return; }
      if (!los || !los.length) return;

      const { data: concepten, error: e2 } = await supabase.from('ingredient_concept').select('id, canonical_naam');
      if (e2) { console.warn('[concept] tabel ontbreekt — draai zelflerend-fase-a-concept-laag.sql:', e2.message); return; }
      const idByNaam = {};
      for (const c of concepten || []) idByNaam[norm(c.canonical_naam)] = c.id;

      let gekoppeld = 0;
      for (const r of los) {
        // Strip neutrale prep-woorden (rauw/rauwe) → "rauwe knoflook" koppelt aan concept "knoflook".
        const cn = conceptSleutel(norm(r.canonical_naam || r.naam));
        if (!cn) continue;
        let cid = idByNaam[cn];
        if (!cid) {
          const { data: nw, error: e3 } = await supabase.from('ingredient_concept').insert({ canonical_naam: cn }).select('id').single();
          if (e3) { // unique-conflict (race) → bestaande ophalen
            const { data: best } = await supabase.from('ingredient_concept').select('id').eq('canonical_naam', cn).single();
            cid = best?.id;
          } else { cid = nw.id; }
          if (cid) idByNaam[cn] = cid;
        }
        if (cid) { await supabase.from('inkoop_prijzen').update({ concept_id: cid }).eq('id', r.id); gekoppeld++; }
      }
      if (gekoppeld) console.log(`[concept] ${gekoppeld} nieuwe rij(en) aan een concept gekoppeld (Passard).`);
    } catch (e) {
      console.warn('[concept] koppelen overgeslagen:', e.message);
    }
  }

  async updatePriceOnly(pageId, price, leverancier, bestaandeLeverancier = '', rawData = '', gramPerEenheid = null) {
    const today = new Date().toISOString().split('T')[0];
    const props = {
      'Kostprijs': { number: price },
    };
    // Leverancier alleen invullen als het veld nog leeg is (bestaande waarde niet overschrijven)
    if ((leverancier || '').trim() && !(bestaandeLeverancier || '').trim()) {
      props['Leverancier'] = { rich_text: [{ text: { content: leverancier.trim() } }] };
    }
    // Probeer 'Laatste update' + 'Raw data' te zetten (velden hoeven niet te bestaan)
    const extra = { ...props, 'Laatste update': { date: { start: today } } };
    if (rawData) extra['Raw data'] = { rich_text: [{ text: { content: rawData.slice(0, 1999) } }] };
    if (gramPerEenheid) extra['Gram per inkoopeenheid'] = { number: gramPerEenheid };
    try {
      await this.client.pages.update({ page_id: pageId, properties: extra });
    } catch {
      await this.client.pages.update({ page_id: pageId, properties: props });
    }
  }

  async addAlias(pageId, currentAliassen, newAlias) {
    const all = [...new Set([...currentAliassen, newAlias.toLowerCase().trim()])].join(', ');
    await this.client.pages.update({
      page_id: pageId,
      properties: { 'Aliassen': { rich_text: [{ text: { content: all } }] } }
    });
  }

  async createProduct(item) {
    const naam = (item.ingredient || '').toLowerCase().trim();
    const today = new Date().toISOString().split('T')[0];
    const props = {
      'Ingredient': { title: [{ text: { content: naam } }] },
      'Kostprijs': { number: item.price },
      'Eenheid': { rich_text: [{ text: { content: item.eenheid || 'kg' } }] },
      'Leverancier': { rich_text: [{ text: { content: item.leverancier || '' } }] },
    };
    // Canonical naam: schone restaurantnaam, los van leverancier-variant. Voor een
    // nieuw product is de canonical standaard zijn eigen (al schone) naam.
    const canonical = (item.canonical_naam || naam).toLowerCase().trim();
    // Optionele velden — alleen toevoegen als ze beschikbaar zijn in het schema
    const rawData = bouwRawData(item);
    const inkoopeenheid = item.inkoopeenheid || parseInkoopeenheid(item.ingredient);
    try {
      await this.client.pages.create({ parent: { database_id: this.dbId }, properties: {
        ...props,
        'Is drank': { checkbox: item.isDrank || false },
        'Categorie': { select: { name: item.categorie || 'droogwaren' } },
        'Canonical naam': { rich_text: [{ text: { content: canonical } }] },
        'Laatste update': { date: { start: today } },
        ...(inkoopeenheid ? { 'Inkoopeenheid': { rich_text: [{ text: { content: inkoopeenheid } }] } } : {}),
        ...(item.gram_per_inkoopeenheid ? { 'Gram per inkoopeenheid': { number: item.gram_per_inkoopeenheid } } : {}),
        ...(rawData ? { 'Raw data': { rich_text: [{ text: { content: rawData.slice(0, 1999) } }] } } : {})
      }});
    } catch {
      // Fallback zonder extra velden als schema ze niet heeft
      await this.client.pages.create({ parent: { database_id: this.dbId }, properties: props });
    }
  }

  async saveHistory(items) {
    const vandaag = new Date().toISOString().split('T')[0];
    for (const item of items) {
      try {
        await this.client.pages.create({
          parent: { database_id: this.historyDbId },
          properties: {
            'Ingredient': { title: [{ text: { content: (item.ingredient || '').toLowerCase().trim() } }] },
            'Prijs': { number: item.price },
            'Eenheid': { rich_text: [{ text: { content: item.eenheid || 'kg' } }] },
            'Leverancier': { rich_text: [{ text: { content: item.leverancier || '' } }] },
            'Datum': { date: { start: item.datum || vandaag } },
          }
        });
      } catch (e) {
        console.error(`[saveHistory] fout bij "${item.ingredient}": ${e.message}`);
      }
    }
  }

  async syncAll(items, { dryRun = false, learnedBlacklist = [] } = {}) {
    if (dryRun) console.log('\n⚙️  DRY-RUN — geen schrijfacties naar Notion\n');

    // Weer HSN-leverancier, non-food en de lerende blacklist vóór verwerking
    const { kept, blocked } = filterScanItems(items, learnedBlacklist);
    const totaalGeweerd = blocked.hsn.length + blocked.nonFood.length + (blocked.drank?.length || 0) + blocked.learned.length;
    if (totaalGeweerd) {
      console.log(`  🚫 ${totaalGeweerd} producten geweerd — HSN:${blocked.hsn.length}, non-food:${blocked.nonFood.length}, drank:${blocked.drank?.length || 0}, blacklist:${blocked.learned.length}`);
    }
    // Datum-varianten samenvoegen: één entry per basisnaam (meest recente prijs),
    // élke variant als los punt in de geschiedenis.
    const { hoofdItems, historieItems } = collapseDatumVarianten(kept);
    items = hoofdItems;

    const existing = await this.getAllPrices();

    // Bouw lookup maps
    const nameMap = {};
    for (const e of existing) {
      nameMap[e.name] = e;
      for (const alias of e.aliassen) nameMap[alias] = e;
    }
    // Artikelnr-index: leverancier|artikelnr → bestaande rij. Het artikelnr is de échte
    // identiteit bij de leverancier — dit voorkomt dat een nét anders geparste naam
    // ("kers" vs "kersen ontpit", zelfde artikel 61168) een duplicaat-rij aanmaakt.
    const artikelMap = {};
    for (const e of existing) {
      const art = (e.rawData || '').match(/artikelnr:\s*([^\s·]+)/i)?.[1];
      if (art && (e.leverancier || '').trim()) artikelMap[`${e.leverancier.toLowerCase().trim()}|${art}`] = e;
    }

    const toCreate = [];
    const results = { updated: 0, created: 0, aliasAdded: 0, geweerd: totaalGeweerd, dryRun };

    for (const item of items) {
      const naam = item.ingredient.toLowerCase().trim();

      // 0. Artikelnr-match (leverancier + artikelnr = zelfde product, ongeacht de naam).
      //    De nieuwe naam wordt alias zodat recept-matching op beide namen blijft werken.
      const artKey = item.artikelnummer && (item.leverancier || '').trim()
        ? `${item.leverancier.toLowerCase().trim()}|${String(item.artikelnummer).trim()}` : null;
      const viaArtikel = artKey && artikelMap[artKey];
      if (viaArtikel) {
        if (dryRun) {
          console.log(`  🔢 ARTIKEL "${naam}" → "${viaArtikel.name}" (artikelnr ${item.artikelnummer})  €${viaArtikel.price ?? '?'} → €${item.price}`);
        } else {
          if (naam !== viaArtikel.name && !viaArtikel.aliassen.includes(naam)) {
            await this.addAlias(viaArtikel.pageId, viaArtikel.aliassen, naam);
            viaArtikel.aliassen.push(naam);
          }
          await this.updatePriceOnly(viaArtikel.pageId, item.price, item.leverancier, viaArtikel.leverancier, bouwRawData(item));
          nameMap[naam] = viaArtikel;
        }
        results.updated++;
        continue;
      }

      // 1. Exacte match (naam of alias)
      const exact = nameMap[naam];
      if (exact) {
        if (dryRun) {
          console.log(`  ✏️  UPDATE  "${naam}"  was €${exact.price ?? '?'} → €${item.price}  (${item.leverancier})`);
        } else {
          await this.updatePriceOnly(exact.pageId, item.price, item.leverancier, exact.leverancier, bouwRawData(item));
        }
        results.updated++;
        continue;
      }

      // 2. Dedup-check (>90% naam + zelfde leverancier + zelfde prijs → alias, geen nieuw ingredient)
      const dedup = findDedupMatch(naam, item.price, item.leverancier, existing);
      if (dedup) {
        const pct = Math.round(dedup.score * 100);
        if (dryRun) {
          console.log(`  [DEDUP]   "${naam}" → "${dedup.match.name}" (${pct}% match, zelfde lev+prijs) — alias toegevoegd`);
        } else {
          await this.addAlias(dedup.match.pageId, dedup.match.aliassen, naam);
          nameMap[naam] = dedup.match;
          console.log(`  [DEDUP] "${naam}" → alias op "${dedup.match.name}" (${pct}%)`);
        }
        results.aliasAdded++;
        continue;
      }

      // 3. Fuzzy match (>80%) — alias + prijs bijwerken
      const fuzzy = findFuzzyMatch(naam, existing);
      if (fuzzy) {
        const pct = Math.round(fuzzy.score * 100);
        if (dryRun) {
          console.log(`  🔗 ALIAS   "${naam}" → "${fuzzy.match.name}" (${pct}% match) — alias toegevoegd, prijs bijgewerkt`);
        } else {
          await this.addAlias(fuzzy.match.pageId, fuzzy.match.aliassen, naam);
          await this.updatePriceOnly(fuzzy.match.pageId, item.price, item.leverancier, fuzzy.match.leverancier, bouwRawData(item));
          nameMap[naam] = fuzzy.match;
        }
        results.aliasAdded++;
        continue;
      }

      // 4. Nieuw product
      toCreate.push(item);
    }

    // Classificeer nieuwe producten in batches van max 20
    if (toCreate.length > 0) {
      if (dryRun) console.log(`\n  🤖 Claude Haiku classificeert ${toCreate.length} nieuwe producten...\n`);
      const BATCH_SIZE = 20;
      for (let i = 0; i < toCreate.length; i += BATCH_SIZE) {
        const batch = toCreate.slice(i, i + BATCH_SIZE);
        let classified = [];
        try {
          classified = await classifyBatch(batch, this.anthropicKey);
          if (dryRun) console.log(`  Batch ${Math.floor(i / BATCH_SIZE) + 1}: ${classified.length} geclassificeerd`);
        } catch (e) {
          console.error(`  ⚠️  Classificatie mislukt: ${e.message}`);
        }

        for (const item of batch) {
          const naam = item.ingredient.toLowerCase().trim();
          const cls = classified.find(c => (c.original || '').toLowerCase().trim() === naam) || {};
          const simpleName = cls.simple_name || naam;
          // Drank-blacklist overschrijft Claude: wijntermen zijn altijd drank
          const drank = cls.is_drank || isDrank(naam);
          const categorie = cls.categorie || 'droogwaren';

          if (dryRun) {
            console.log(`  ✨ NIEUW   "${naam}"`);
            console.log(`           → naam: "${simpleName}" | categorie: ${categorie} | is_drank: ${drank}`);
            console.log(`           → prijs: €${item.price}/${item.eenheid} via ${item.leverancier}`);
          } else {
            await this.createProduct({ ...item, ingredient: simpleName, isDrank: drank, categorie });
          }
          results.created++;
        }
      }
    }

    if (!dryRun) await this.saveHistory(historieItems);

    return results;
  }
}

module.exports = NotionSync;
module.exports.matchCanonicalViaHaiku = matchCanonicalViaHaiku;
module.exports.filterScanItems = filterScanItems;
module.exports.isNonFood = isNonFood;
module.exports.isGeblokkeerdeLeverancier = isGeblokkeerdeLeverancier;
module.exports.NON_FOOD_BLACKLIST = NON_FOOD_BLACKLIST;
module.exports.isDrank = isDrank;
module.exports.DRANK_BLACKLIST = DRANK_BLACKLIST;
module.exports.stripDatum = stripDatum;
module.exports.parseDatumUitNaam = parseDatumUitNaam;
module.exports.collapseDatumVarianten = collapseDatumVarianten;
module.exports.bouwRawData = bouwRawData;
module.exports.parseInkoopeenheid = parseInkoopeenheid;
module.exports.normaliseerKwaliteit = normaliseerKwaliteit;
module.exports.parseGramPerInkoopeenheid = parseGramPerInkoopeenheid;
module.exports.normaliseerPrijsPerKg = normaliseerPrijsPerKg;
