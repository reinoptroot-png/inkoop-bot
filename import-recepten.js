// Receptencomposer — Fase 2: DRY-RUN importer.
// Leest receptpagina's uit een Notion Recipes-database, parset het sjabloon
// (src/recept-parse.js) en RAPPORTEERT wat er geïmporteerd zou worden.
// Schrijft (nog) NIETS naar Supabase en roept (nog) GEEN Haiku aan — dat is de
// volgende stap, pas nadat dit rapport klopt.
//
//   node import-recepten.js                 # Europa Recipes, dry-run
//   node import-recepten.js --db <id>       # andere database
//   node import-recepten.js --all           # beide Recipes-databases
//   node import-recepten.js --limit 10      # eerste N recepten
//   node import-recepten.js --details       # toon de regels per recept

let s = {}; try { s = require('./settings.json'); } catch (e) {}
require('dotenv').config();
const { Client } = require('@notionhq/client');
const { parseRecept } = require('./src/recept-parse');

const notion = new Client({ auth: s.notionToken || process.env.NOTION_TOKEN });

const DBS = {
  europa: '6af9b995-4ba8-43e6-b76e-df7ce9f80f0a',   // Europa Recipes
  simpel: 'dbf9f02c-bf28-4751-9b2a-fc8fd9237e8e',   // Recipes (simpel)
};

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const txt = (cells) => (cells || []).map(t => t.plain_text).join('');

async function leesTabellen(pageId) {
  const ch = await notion.blocks.children.list({ block_id: pageId, page_size: 100 });
  const tables = ch.results.filter(b => b.type === 'table');
  let metaRows = [], ingredientRows = [];
  for (const t of tables) {
    const rr = await notion.blocks.children.list({ block_id: t.id, page_size: 100 });
    const rows = rr.results.map(r => r.table_row.cells.map(c => txt(c)));
    if (t.table.table_width === 2) metaRows = rows;
    else ingredientRows = rows; // breedte 4 = ingrediëntentabel
  }
  return { metaRows, ingredientRows };
}

async function verwerkDb(dbId, limit) {
  const recepten = [];
  let cursor;
  do {
    const q = await notion.databases.query({ database_id: dbId, page_size: 100, start_cursor: cursor });
    for (const page of q.results) {
      const titleProp = Object.values(page.properties).find(p => p.type === 'title');
      const naam = titleProp ? titleProp.title.map(t => t.plain_text).join('').trim() : null;
      const { metaRows, ingredientRows } = await leesTabellen(page.id);
      const parsed = parseRecept({ naam, metaRows, ingredientRows });
      recepten.push({ page_id: page.id, ...parsed });
      if (limit && recepten.length >= limit) return recepten;
    }
    cursor = q.has_more ? q.next_cursor : undefined;
  } while (cursor);
  return recepten;
}

(async () => {
  const limit = parseInt(opt('--limit', '0'), 10) || 0;
  const dbIds = flag('--all') ? Object.values(DBS) : [opt('--db', DBS.europa)];

  console.log('=== DRY-RUN — er wordt NIETS geschreven ===\n');
  let totaal = 0, compleet = 0, incompleet = 0, totRegels = 0;

  for (const dbId of dbIds) {
    const recepten = await verwerkDb(dbId, limit);
    console.log(`Database ${dbId} — ${recepten.length} recepten:\n`);
    for (const r of recepten) {
      totaal++; totRegels += r.regels.length;
      if (r.compleet) compleet++; else incompleet++;
      const status = r.compleet ? '✓ compleet' : '⚠ incompleet';
      const yld = r.opbrengst != null ? `${r.opbrengst}${r.opbrengst_eenheid || ''}` : 'geen yield';
      console.log(`  ${status}  ${r.naam || '(geen naam)'} — ${r.regels.length} regels, opbrengst: ${yld}`);
      if (flag('--details')) for (const reg of r.regels) {
        console.log(`        · ${reg.naam} — ${reg.hoeveelheid ?? '?'} ${reg.eenheid || ''}`);
      }
    }
    console.log('');
  }

  console.log('=== Samenvatting ===');
  console.log(`  recepten:   ${totaal}`);
  console.log(`  compleet:   ${compleet}  (yield + minstens 1 regel)`);
  console.log(`  incompleet: ${incompleet}  (geen yield of geen regels)`);
  console.log(`  regels totaal: ${totRegels}`);
  console.log('\nVolgende stap (nog te bouwen): elke regel via Haiku matchen tegen ingrediënten/bereidingen,');
  console.log('onbekende regels naar een review-queue, en met --commit wegschrijven naar Supabase (idempotent op page_id).');
})().catch(e => { console.error('FOUT:', e.message); process.exit(1); });
