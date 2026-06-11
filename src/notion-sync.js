const { Client } = require('@notionhq/client');
const fetch = require('node-fetch');

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
// Vooral Franse wijntermen — diacriet-ongevoelig, op hele-woord match zodat
// "cru" niet matcht in "crudités" en "cave" niet in onschuldige woorden.
const DRANK_BLACKLIST = [
  'vins', 'pirouettes', 'cuvée', 'château', 'domaine', 'cépage',
  'millésime', 'cave', 'vignoble', 'cru',
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

// Voeg datum-varianten samen. Retourneert:
//  - hoofdItems:    één item per basisnaam, met de prijs van de MEEST RECENTE datum
//                   (voor de Inkoop Prijzen entry — géén losse entry per datum).
//  - historieItems: élke variant met basisnaam + eigen datum (voor de Inkoop
//                   Geschiedenis — aparte stippen in de prijsgrafiek).
function collapseDatumVarianten(items) {
  const vandaag = new Date().toISOString().split('T')[0];
  const historieItems = (items || []).map(it => ({
    ...it,
    ingredient: stripDatum(it.ingredient),
    datum: parseDatumUitNaam(it.ingredient) || vandaag,
  }));
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
  add('artikelnr', item.artikelnummer);
  add('barcode', item.barcode);
  add('omschrijving', item.omschrijving);
  add('gewicht', item.gewicht);
  add('verpakking', item.verpakking);
  add('eenheid', item.eenheid);
  add('prijs', item.price != null ? `€ ${Number(item.price).toFixed(2)}` : null);
  add('btw', item.btw);
  add('factuurnr', item.factuurnummer);
  add('ordernr', item.ordernummer);
  add('herkomst', item.herkomst);
  add('kwaliteitsklasse', item.kwaliteitsklasse);
  add('temperatuur', item.temperatuur);
  add('min. bestelling', item.min_bestelling);
  return v.join(' · ');
}

// Filter scan-items vóór verwerking: HSN-leverancier, non-food, en de lerende
// blacklist (uit Supabase non_food_blacklist). Retourneert { kept, blocked }.
function filterScanItems(items, learnedBlacklist = []) {
  const learnedSet = new Set((learnedBlacklist || []).map(s => (s || '').toLowerCase().trim()).filter(Boolean));
  const kept = [];
  const blocked = { hsn: [], nonFood: [], learned: [] };
  for (const item of items) {
    const naam = (item.ingredient || '').toLowerCase().trim();
    if (isGeblokkeerdeLeverancier(item.leverancier)) { blocked.hsn.push(naam); continue; }
    if (isNonFood(naam)) { blocked.nonFood.push(naam); continue; }
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
        results.push({
          pageId: page.id,
          name: name.toLowerCase().trim(),
          price: props['Kostprijs']?.number ?? null,
          eenheid: props['Eenheid']?.rich_text?.[0]?.plain_text || 'kg',
          leverancier: props['Leverancier']?.rich_text?.[0]?.plain_text || '',
          aliassen: aliasRaw ? aliasRaw.split(',').map(a => a.trim().toLowerCase()).filter(Boolean) : [],
          isDrank: props['Is drank']?.checkbox || false,
          categorie: props['Categorie']?.select?.name || '',
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
          laatste_update: props['Laatste update']?.last_edited_time || page.last_edited_time || null,
          updated_at: runTs,
        });
      }
      cursor = r.has_more ? r.next_cursor : undefined;
    } while (cursor);

    for (let i = 0; i < rows.length; i += 100) {
      const { error } = await supabase.from('inkoop_prijzen').upsert(rows.slice(i, i + 100), { onConflict: 'id' });
      if (error) { console.warn('[mirror] upsert fout:', error.message); return { error: error.message }; }
    }
    // Prune: alles wat deze run niet is bijgewerkt = niet meer in Notion → weg
    if (rows.length) {
      const { error } = await supabase.from('inkoop_prijzen').delete().lt('updated_at', runTs);
      if (error) console.warn('[mirror] prune fout:', error.message);
    }
    return { count: rows.length };
  }

  async updatePriceOnly(pageId, price, leverancier, bestaandeLeverancier = '', rawData = '') {
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
    // Optionele velden — alleen toevoegen als ze beschikbaar zijn in het schema
    const rawData = bouwRawData(item);
    try {
      await this.client.pages.create({ parent: { database_id: this.dbId }, properties: {
        ...props,
        'Is drank': { checkbox: item.isDrank || false },
        'Categorie': { select: { name: item.categorie || 'droogwaren' } },
        'Laatste update': { date: { start: today } },
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
    const totaalGeweerd = blocked.hsn.length + blocked.nonFood.length + blocked.learned.length;
    if (totaalGeweerd) {
      console.log(`  🚫 ${totaalGeweerd} producten geweerd — HSN:${blocked.hsn.length}, non-food:${blocked.nonFood.length}, blacklist:${blocked.learned.length}`);
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

    const toCreate = [];
    const results = { updated: 0, created: 0, aliasAdded: 0, geweerd: totaalGeweerd, dryRun };

    for (const item of items) {
      const naam = item.ingredient.toLowerCase().trim();

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
