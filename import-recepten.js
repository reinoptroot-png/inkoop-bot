// Receptencomposer — Fase 2: importer (dry-run default, --commit schrijft).
//
// Leest receptpagina's uit de Notion Recipes-databases, parset het sjabloon,
// schat de yield als 'Opbrengst' ontbreekt (geflagd), koppelt elke regel
// deterministisch aan een ingrediënt of bereiding, en schrijft (met --commit)
// idempotent naar Supabase. Niet-herkende regels gaan naar bereiding_import_review.
//
//   node import-recepten.js                 # DRY-RUN (geen writes)
//   node import-recepten.js --commit        # schrijf naar Supabase
//   node import-recepten.js --limit 20      # eerste N per database
//   node import-recepten.js --details       # toon regels + match per recept
//
// Vereist (commit): SUPABASE_URL + SUPABASE_ANON_KEY in .env, en de SQL uit
// receptencomposer.sql + receptencomposer-fase2.sql gedraaid.

let s = {}; try { s = require('./settings.json'); } catch (e) {}
require('dotenv').config();
const { Client } = require('@notionhq/client');
const { parseRecept } = require('./src/recept-parse');
const { schatYield, basisNaarOutputEenheid, yieldVerlies, normEenheid, matchLokaal, normNaam } = require('./src/recept-import-lib');
const { matchRegelViaHaiku } = require('./src/bereiding-match');

const notion = new Client({ auth: s.notionToken || process.env.NOTION_TOKEN, timeoutMs: 120000 });

// Notion-calls kunnen incidenteel time-outen; retry met backoff i.p.v. de hele import laten falen.
async function withRetry(fn, label = 'notion', n = 4) {
  for (let i = 1; i <= n; i++) {
    try { return await fn(); }
    catch (e) {
      const tijdelijk = /timed out|timeout|ECONNRESET|fetch failed|rate.?limit|502|503|504/i.test(e.message || '');
      if (i === n || !tijdelijk) throw e;
      const wacht = 1000 * 2 ** (i - 1);
      console.warn(`  ⚠ ${label} poging ${i} faalde (${e.message}); retry over ${wacht}ms`);
      await new Promise(r => setTimeout(r, wacht));
    }
  }
}

// Welke Recipes-database hoort bij welk restaurant.
const DB_LOCATIE = [
  { id: '6af9b995-4ba8-43e6-b76e-df7ce9f80f0a', locatie: 'europa' },
  { id: 'dbf9f02c-bf28-4751-9b2a-fc8fd9237e8e', locatie: 'europizza' },
];

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
// Page-mentions (📄-links naar een ander recept = nesting) komen via de API vaak binnen als
// lege/"Untitled" plain_text. Resolve dan de echte paginatitel, anders valt de geneste regel weg.
async function cellTekst(cell) {
  let out = '';
  for (const t of (cell || [])) {
    const leeg = !t.plain_text || t.plain_text.trim().toLowerCase() === 'untitled';
    if (t.type === 'mention' && t.mention?.type === 'page' && leeg) {
      try {
        const p = await withRetry(() => notion.pages.retrieve({ page_id: t.mention.page.id }), 'mention');
        const tp = Object.values(p.properties).find(x => x.type === 'title');
        out += tp ? tp.title.map(z => z.plain_text).join('') : (t.plain_text || '');
      } catch { out += t.plain_text || ''; }
    } else out += t.plain_text || '';
  }
  return out;
}
const txt = (cells) => (cells || []).map(t => t.plain_text).join('');
const COMMIT = flag('--commit');
const limit = parseInt(opt('--limit', '0'), 10) || 0;

// Haiku-fallback: als matchLokaal niets vindt, laat Haiku de regel disambigueren.
// Aan tenzij --no-haiku of geen key. Draait in dry-run én commit (eerlijke preview).
const anthropicKey = s.anthropicKey || process.env.ANTHROPIC_API_KEY;
const USE_HAIKU = !flag('--no-haiku') && !!anthropicKey;

let supabase = null;
if (process.env.SUPABASE_URL && (process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY)) {
  supabase = require('@supabase/supabase-js').createClient(
    process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY);
}

async function leesTabellen(pageId) {
  const ch = await withRetry(() => notion.blocks.children.list({ block_id: pageId, page_size: 100 }), 'blocks');
  let metaRows = [], ingredientRows = [];
  for (const t of ch.results.filter(b => b.type === 'table')) {
    const rr = await withRetry(() => notion.blocks.children.list({ block_id: t.id, page_size: 100 }), 'table');
    // cellTekst resolvet page-mentions naar hun titel (zie boven); vandaar async.
    const rows = await Promise.all(rr.results.map(r => Promise.all(r.table_row.cells.map(c => cellTekst(c)))));
    if (t.table.table_width === 2) metaRows = rows; else ingredientRows = rows;
  }
  return { metaRows, ingredientRows };
}

// Bepaal eind-yield + output-eenheid + vlaggen.
function bepaalYield(parsed) {
  if (parsed.opbrengst != null && parsed.opbrengst > 0) {
    const n = normEenheid(parsed.opbrengst_eenheid);
    return { eind_yield: parsed.opbrengst, output_eenheid: n ? basisNaarOutputEenheid(n.basis) : 'gram', yield_geschat: false, yield_bron: 'opbrengst' };
  }
  const sch = schatYield(parsed.regels);
  if (sch) {
    // Massa/volume verdampt bij inkoken/garen → echte yield < som inputs. Pas een ruwe
    // verliesfactor toe op basis van de methode in de naam (niet bij 'stuks' — aantallen
    // gaan niet verloren door koken). Blijft GEFLAGD als schatting.
    const v = (sch.basis === 'g' || sch.basis === 'ml') ? yieldVerlies(parsed.naam) : null;
    const yld = v ? Math.round(sch.yield * v.factor) : sch.yield;
    return {
      eind_yield: yld, output_eenheid: basisNaarOutputEenheid(sch.basis), yield_geschat: true,
      yield_bron: v ? `som van inputs × ${v.factor} (${v.methode})` : 'som van inputs',
    };
  }
  return { eind_yield: null, output_eenheid: 'gram', yield_geschat: false, yield_bron: null };
}

async function laadRecepten() {
  // 1) Verzamel alle pagina's (snel: ~1 query-call per database).
  const pages = [];
  for (const { id, locatie } of DB_LOCATIE) {
    let cursor, count = 0;
    do {
      const q = await withRetry(() => notion.databases.query({ database_id: id, page_size: 100, start_cursor: cursor }), 'query');
      for (const page of q.results) {
        const tp = Object.values(page.properties).find(p => p.type === 'title');
        const naam = tp ? tp.title.map(t => t.plain_text).join('').trim() : null;
        pages.push({ page_id: page.id, locatie, naam });
        if (limit && ++count >= limit) break;
      }
      cursor = (!limit || count < limit) && q.has_more ? q.next_cursor : undefined;
    } while (cursor);
  }
  // 2) Tabellen PARALLEL inlezen (batches van 6). Was strikt sequentieel (1 pagina tegelijk,
  //    ~3-4 Notion-calls elk) → ~200 calls op een rij = de traagheid/timeouts. Nu: ~6 tegelijk.
  const out = [];
  const CONC = 3;  // Notion limiteert hard op ~3 req/s; hoger geeft enkel rate-limit-backoff.
  for (let i = 0; i < pages.length; i += CONC) {
    const res = await Promise.all(pages.slice(i, i + CONC).map(async (p) => {
      const { metaRows, ingredientRows } = await leesTabellen(p.page_id);
      const parsed = parseRecept({ naam: p.naam, metaRows, ingredientRows });
      return { page_id: p.page_id, locatie: p.locatie, ...parsed, ...bepaalYield(parsed) };
    }));
    out.push(...res);
    console.log(`  Notion ingelezen: ${Math.min(i + CONC, pages.length)}/${pages.length} recepten…`);
  }
  return out;
}

// Mirror: ruwe receptdata (mét geresolvede mentions) wegschrijven naar Supabase `recept_bron`,
// zodat her-matchen Notion niet meer hoeft te lezen. Tolerant als de tabel nog niet bestaat.
async function mirrorNaarBron(recepten) {
  if (!supabase) return;
  const rows = recepten.filter(r => r.naam).map(r => ({
    notion_page_id: r.page_id, locatie: r.locatie, naam: r.naam,
    opbrengst: r.opbrengst ?? null, opbrengst_eenheid: r.opbrengst_eenheid ?? null,
    regels: r.regels || [], gemirrord_op: new Date().toISOString(),
  }));
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await supabase.from('recept_bron').upsert(rows.slice(i, i + 200), { onConflict: 'notion_page_id' });
    if (error) { console.warn(`  ⚠ recept_bron mirror overgeslagen: ${error.message} (SQL receptencomposer-recept-bron.sql gedraaid?)`); return; }
  }
  console.log(`  ✓ ${rows.length} recepten gespiegeld naar recept_bron`);
}

// Lezen uit de mirror i.p.v. Notion (--from-mirror). Reconstrueert dezelfde vorm als laadRecepten.
async function laadUitMirror() {
  if (!supabase) throw new Error('--from-mirror vereist Supabase');
  const { data, error } = await supabase.from('recept_bron').select('*');
  if (error) throw new Error('recept_bron lezen mislukt: ' + error.message + ' (SQL gedraaid + gevuld?)');
  return (data || []).map(r => {
    const parsed = { naam: r.naam, opbrengst: r.opbrengst, opbrengst_eenheid: r.opbrengst_eenheid, regels: r.regels || [] };
    return { page_id: r.notion_page_id, locatie: r.locatie, ...parsed, ...bepaalYield(parsed) };
  });
}

async function laadIngredientIndex() {
  if (!supabase) return [];
  const { data, error } = await supabase.from('inkoop_prijzen').select('id, naam, canonical_naam, aliassen');
  if (error) throw error;
  return (data || []).map(r => ({
    id: r.id,
    namen: [r.canonical_naam, r.naam, ...String(r.aliassen || '').split(',')].map(x => (x || '').trim()).filter(Boolean),
  }));
}

// Zelflerend: schrijf de (afwijkende) receptnaam terug als alias op het inkoop-ingredient,
// zodat matchLokaal 'm volgende keer deterministisch vangt (geen Haiku/review meer nodig).
// Werkt ook de in-memory index bij zodat latere regels in dezelfde run mee profiteren.
async function leerAlias(ingredientId, receptNaam, index) {
  const doel = normNaam(receptNaam);
  if (!doel) return false;
  const inMem = (index || []).find(c => c.id === ingredientId);
  if (inMem && (inMem.namen || []).some(n => normNaam(n) === doel)) return false; // al bekend
  if (COMMIT && supabase) {
    const { data: row } = await supabase.from('inkoop_prijzen').select('aliassen').eq('id', ingredientId).single();
    const bestaand = String(row?.aliassen || '').split(',').map(x => x.trim()).filter(Boolean);
    if (bestaand.some(a => normNaam(a) === doel)) return false;
    bestaand.push(receptNaam.trim());
    await supabase.from('inkoop_prijzen').update({ aliassen: bestaand.join(', ') }).eq('id', ingredientId);
  }
  if (inMem) inMem.namen.push(receptNaam.trim());
  return true;
}

(async () => {
  if (COMMIT && !supabase) { console.error('FOUT: --commit vereist SUPABASE_URL + SUPABASE_ANON_KEY in .env'); process.exit(1); }
  console.log(COMMIT ? '=== COMMIT — schrijft naar Supabase ===\n' : '=== DRY-RUN — geen writes ===\n');

  // Bron: Notion (default) of de Supabase-mirror (--from-mirror, geen Notion-calls → instant).
  const FROM_MIRROR = flag('--from-mirror');
  const recepten = FROM_MIRROR ? await laadUitMirror() : await laadRecepten();
  console.log(`  bron: ${FROM_MIRROR ? 'recept_bron (mirror)' : 'Notion'} — ${recepten.length} recepten`);
  // Na een Notion-read: de mirror (her)vullen zodat een volgende run --from-mirror kan gebruiken.
  if (!FROM_MIRROR && COMMIT) await mirrorNaarBron(recepten);
  const ingredientIndex = supabase ? await laadIngredientIndex() : [];

  // canonical_id + bereiding_id per recept (alleen bij commit echte ids).
  const bereidingByPage = new Map();
  if (COMMIT) {
    for (const r of recepten) {
      if (!r.naam) continue;
      const canon = r.naam.toLowerCase().trim();
      const { data: cb, error: e1 } = await supabase.from('canonical_bereiding')
        .upsert({ canonical_naam: canon, output_eenheid: r.output_eenheid }, { onConflict: 'canonical_naam' })
        .select('id').single();
      if (e1) { console.warn('  ⚠ canonical upsert', canon, e1.message); continue; }
      const { data: b, error: e2 } = await supabase.from('bereiding')
        .upsert({
          canonical_id: cb.id, locatie: r.locatie, notion_page_id: r.page_id,
          eind_yield: r.eind_yield, yield_geschat: r.yield_geschat, yield_bron: r.yield_bron,
          is_incompleet: r.eind_yield == null,
        }, { onConflict: 'notion_page_id' })
        .select('id').single();
      if (e2) { console.warn('  ⚠ bereiding upsert', canon, e2.message); continue; }
      bereidingByPage.set(r.page_id, b.id);
    }
  }

  // Bereiding-index voor matching: bij commit echte ids (zelfde locatie eerst),
  // bij dry-run de receptnamen als pseudo-bereidingen.
  const bereidingIndex = recepten.filter(r => r.naam).map(r => ({
    id: COMMIT ? bereidingByPage.get(r.page_id) : `(nieuw:${r.locatie})`,
    namen: [r.naam], locatie: r.locatie,
  }));

  let nMatch = 0, nReview = 0, nComp = 0, nGeschat = 0, nIncompleet = 0, nHaiku = 0, nGeleerd = 0;
  if (USE_HAIKU) console.log('  (Haiku-fallback actief voor niet-lokaal herkende regels)\n');

  // Fase A: bestaande componenten/review wissen + lokaal matchen; regels verzamelen als 'taken'.
  const taken = [];  // { r, reg, bid, index?, m, via, geenHoev? }
  for (const r of recepten) {
    if (r.yield_geschat) nGeschat++;
    if (r.eind_yield == null) nIncompleet++;
    const bid = bereidingByPage.get(r.page_id);
    if (COMMIT && bid) {
      await supabase.from('bereiding_component').delete().eq('bereiding_id', bid);
      await supabase.from('bereiding_import_review').delete().eq('bereiding_id', bid);
    }
    for (const reg of r.regels) {
      if (reg.hoeveelheid == null) { taken.push({ r, reg, bid, geenHoev: true }); continue; }
      const index = { ingredients: ingredientIndex, bereidingen: bereidingIndex.filter(b => b.locatie === r.locatie && b.namen[0].toLowerCase() !== (r.naam || '').toLowerCase()) };
      const m = matchLokaal(reg.naam, index);
      taken.push({ r, reg, bid, index, m, via: m ? `${(m.score * 100).toFixed(0)}%` : null });
    }
  }

  // Fase B: Haiku PARALLEL (concurrency 10) voor de niet-lokaal-gematchte regels — dit was de bottleneck.
  const teHaiku = USE_HAIKU ? taken.filter(t => !t.geenHoev && !t.m) : [];
  if (teHaiku.length) console.log(`  lokaal: ${taken.filter(t => t.m).length} · naar Haiku: ${teHaiku.length}`);
  const CONC = 3;  // laag houden: grote match-prompts × hoge concurrency overschrijdt de Anthropic token-rate-limit
  for (let i = 0; i < teHaiku.length; i += CONC) {
    await Promise.all(teHaiku.slice(i, i + CONC).map(async t => {
      const hk = await matchRegelViaHaiku(t.reg.naam, {
        ingredients: t.index.ingredients.map(c => ({ id: c.id, canonical: c.namen[0] })).filter(c => c.canonical),
        bereidingen: t.index.bereidingen.map(b => ({ id: b.id, canonical: b.namen[0] })).filter(b => b.canonical),
      }, anthropicKey);
      if (hk && hk.id) { t.m = { id: hk.id, type: hk.type, score: hk.confidence / 100 }; t.via = `haiku ${hk.confidence}%`; nHaiku++; }
    }));
    if (teHaiku.length > CONC) console.log(`  Haiku ${Math.min(i + CONC, teHaiku.length)}/${teHaiku.length}…`);
  }

  // Fase C: schrijven + tellen + --details (per recept gegroepeerd).
  const takenVoor = new Map();
  for (const t of taken) { if (!takenVoor.has(t.r)) takenVoor.set(t.r, []); takenVoor.get(t.r).push(t); }
  for (const r of recepten) {
    const regelInfo = [];
    for (const t of (takenVoor.get(r) || [])) {
      const { reg, bid, m, via, geenHoev } = t;
      if (geenHoev) {
        nReview++;
        regelInfo.push(`${reg.naam} → review (geen hoeveelheid)`);
        if (COMMIT && bid) await supabase.from('bereiding_import_review').insert({ bereiding_id: bid, regel_naam: reg.naam, hoeveelheid: null, eenheid: reg.eenheid });
        continue;
      }
      if (m && m.id) {
        nMatch++;
        if (m.type === 'ingredient' && m.score < 1 && await leerAlias(m.id, reg.naam, ingredientIndex)) nGeleerd++;
        regelInfo.push(`${reg.naam} → ${m.type} (${via})`);
        if (COMMIT && bid) {
          const row = { bereiding_id: bid, hoeveelheid: reg.hoeveelheid, eenheid: reg.eenheid || 'g' };
          if (m.type === 'bereiding') row.sub_bereiding_id = m.id; else row.ingredient_id = m.id;
          const { error } = await supabase.from('bereiding_component').insert(row);
          if (!error) nComp++; else console.warn('    ⚠ component', reg.naam, error.message);
        } else nComp++;
      } else {
        nReview++;
        regelInfo.push(`${reg.naam} → review`);
        if (COMMIT && bid) await supabase.from('bereiding_import_review').insert({ bereiding_id: bid, regel_naam: reg.naam, hoeveelheid: reg.hoeveelheid, eenheid: reg.eenheid });
      }
    }
    if (flag('--details')) {
      const yld = r.eind_yield != null ? `${r.eind_yield} ${r.output_eenheid}${r.yield_geschat ? ' (geschat)' : ''}` : 'geen yield';
      console.log(`  ${r.naam || '(geen naam)'} [${r.locatie}] — yield: ${yld}`);
      for (const ri of regelInfo) console.log(`        · ${ri}`);
    }
  }

  console.log('\n=== Samenvatting ===');
  console.log(`  recepten:            ${recepten.length}`);
  console.log(`  yield geschat:       ${nGeschat}  (Opbrengst ontbrak → som van inputs)`);
  console.log(`  nog incompleet:      ${nIncompleet}  (geen yield én niet schatbaar)`);
  console.log(`  regels gekoppeld:    ${nMatch}  (waarvan ${nHaiku} via Haiku-fallback)`);
  console.log(`  aliassen geleerd:    ${nGeleerd}  (receptnaam → inkoop-ingredient, ${COMMIT ? 'weggeschreven' : 'zou leren'})`);
  console.log(`  regels naar review:  ${nReview}`);
  console.log(`  componenten ${COMMIT ? 'geschreven' : '(zou schrijven)'}: ${nComp}`);
  if (!COMMIT) console.log('\nDraai met --commit om dit echt weg te schrijven (idempotent op notion_page_id).');
  else console.log('\n✓ Geschreven. Draai daarna de webapp-compute (pages/api/bereidingen/compute) voor de prijzen.');
})().catch(e => { console.error('FOUT:', e.message); process.exit(1); });
