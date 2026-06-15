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
const { schatYield, basisNaarOutputEenheid, normEenheid, matchLokaal } = require('./src/recept-import-lib');

const notion = new Client({ auth: s.notionToken || process.env.NOTION_TOKEN });

// Welke Recipes-database hoort bij welk restaurant.
const DB_LOCATIE = [
  { id: '6af9b995-4ba8-43e6-b76e-df7ce9f80f0a', locatie: 'europa' },
  { id: 'dbf9f02c-bf28-4751-9b2a-fc8fd9237e8e', locatie: 'europizza' },
];

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const txt = (cells) => (cells || []).map(t => t.plain_text).join('');
const COMMIT = flag('--commit');
const limit = parseInt(opt('--limit', '0'), 10) || 0;

let supabase = null;
if (process.env.SUPABASE_URL && (process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY)) {
  supabase = require('@supabase/supabase-js').createClient(
    process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY);
}

async function leesTabellen(pageId) {
  const ch = await notion.blocks.children.list({ block_id: pageId, page_size: 100 });
  let metaRows = [], ingredientRows = [];
  for (const t of ch.results.filter(b => b.type === 'table')) {
    const rr = await notion.blocks.children.list({ block_id: t.id, page_size: 100 });
    const rows = rr.results.map(r => r.table_row.cells.map(c => txt(c)));
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
  if (sch) return { eind_yield: sch.yield, output_eenheid: basisNaarOutputEenheid(sch.basis), yield_geschat: true, yield_bron: 'som van inputs' };
  return { eind_yield: null, output_eenheid: 'gram', yield_geschat: false, yield_bron: null };
}

async function laadRecepten() {
  const out = [];
  for (const { id, locatie } of DB_LOCATIE) {
    let cursor, count = 0;
    do {
      const q = await notion.databases.query({ database_id: id, page_size: 100, start_cursor: cursor });
      for (const page of q.results) {
        const tp = Object.values(page.properties).find(p => p.type === 'title');
        const naam = tp ? tp.title.map(t => t.plain_text).join('').trim() : null;
        const { metaRows, ingredientRows } = await leesTabellen(page.id);
        const parsed = parseRecept({ naam, metaRows, ingredientRows });
        out.push({ page_id: page.id, locatie, ...parsed, ...bepaalYield(parsed) });
        if (limit && ++count >= limit) break;
      }
      cursor = (!limit || count < limit) && q.has_more ? q.next_cursor : undefined;
    } while (cursor);
  }
  return out;
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

(async () => {
  if (COMMIT && !supabase) { console.error('FOUT: --commit vereist SUPABASE_URL + SUPABASE_ANON_KEY in .env'); process.exit(1); }
  console.log(COMMIT ? '=== COMMIT — schrijft naar Supabase ===\n' : '=== DRY-RUN — geen writes ===\n');

  const recepten = await laadRecepten();
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

  let nMatch = 0, nReview = 0, nComp = 0, nGeschat = 0, nIncompleet = 0;

  for (const r of recepten) {
    if (r.yield_geschat) nGeschat++;
    if (r.eind_yield == null) nIncompleet++;
    const bid = bereidingByPage.get(r.page_id);
    if (COMMIT && bid) {
      await supabase.from('bereiding_component').delete().eq('bereiding_id', bid);
      await supabase.from('bereiding_import_review').delete().eq('bereiding_id', bid);
    }
    const regelInfo = [];
    for (const reg of r.regels) {
      // Regel zonder hoeveelheid kan geen component zijn (NOT NULL) → naar review.
      if (reg.hoeveelheid == null) {
        nReview++;
        regelInfo.push(`${reg.naam} → review (geen hoeveelheid)`);
        if (COMMIT && bid) await supabase.from('bereiding_import_review').insert({ bereiding_id: bid, regel_naam: reg.naam, hoeveelheid: null, eenheid: reg.eenheid });
        continue;
      }
      // sub-bereidingen van dezelfde locatie krijgen voorrang
      const index = { ingredients: ingredientIndex, bereidingen: bereidingIndex.filter(b => b.locatie === r.locatie && b.namen[0].toLowerCase() !== (r.naam || '').toLowerCase()) };
      const m = matchLokaal(reg.naam, index);
      if (m && m.id) {
        nMatch++;
        regelInfo.push(`${reg.naam} → ${m.type} (${(m.score * 100).toFixed(0)}%)`);
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
  console.log(`  regels gekoppeld:    ${nMatch}`);
  console.log(`  regels naar review:  ${nReview}`);
  console.log(`  componenten ${COMMIT ? 'geschreven' : '(zou schrijven)'}: ${nComp}`);
  if (!COMMIT) console.log('\nDraai met --commit om dit echt weg te schrijven (idempotent op notion_page_id).');
  else console.log('\n✓ Geschreven. Draai daarna de webapp-compute (pages/api/bereidingen/compute) voor de prijzen.');
})().catch(e => { console.error('FOUT:', e.message); process.exit(1); });
