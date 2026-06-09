/**
 * Eenmalige opschoningsscan van de Inkoop Prijzen database.
 * Archiveert bestaande troep die nooit in de database had mogen staan:
 *   - alle producten van geblokkeerde leveranciers (HSN)
 *   - alle non-food producten die matchen met NON_FOOD_BLACKLIST
 * Food-producten worden NOOIT aangeraakt.
 *
 * Gebruik:
 *   node src/cleanup-prijzen.js --dry-run   (alleen rapporteren, niets wijzigen)
 *   node src/cleanup-prijzen.js             (daadwerkelijk archiveren)
 *
 * Archiveren = Notion pages.update archived:true (omkeerbaar via Notion-prullenbak).
 */
require('dotenv').config();
const { Client } = require('@notionhq/client');
const { isGeblokkeerdeLeverancier, isNonFood } = require('./notion-sync');

const PRICES_DB = (process.env.NOTION_DB_ID || 'b6258a232e6d4482b7b4f50cf449854f').trim();
const dryRun = process.argv.includes('--dry-run');
const notion = new Client({ auth: (process.env.NOTION_TOKEN || '').trim() });

async function allPages() {
  const out = [];
  let cursor;
  do {
    const r = await notion.databases.query({ database_id: PRICES_DB, start_cursor: cursor, page_size: 100 });
    out.push(...r.results);
    cursor = r.has_more ? r.next_cursor : undefined;
  } while (cursor);
  return out;
}

(async () => {
  if (!process.env.NOTION_TOKEN) { console.error('NOTION_TOKEN ontbreekt'); process.exit(1); }
  console.log(`[cleanup] ${dryRun ? 'DRY-RUN — ' : ''}scan Inkoop Prijzen (${PRICES_DB})`);

  const pages = await allPages();
  const active = pages.filter(p => !p.archived);
  console.log(`[cleanup] ${active.length} actieve producten gevonden\n`);

  const hsn = [], nonfood = [];
  for (const p of active) {
    const naam = p.properties['Ingredient']?.title?.[0]?.plain_text || '';
    if (!naam) continue;
    const lev = p.properties['Leverancier']?.rich_text?.[0]?.plain_text || '';
    if (isGeblokkeerdeLeverancier(lev)) { hsn.push({ id: p.id, naam, lev }); continue; }
    if (isNonFood(naam))               { nonfood.push({ id: p.id, naam, lev }); continue; }
  }

  console.log(`=== HSN (${hsn.length}) ===`);
  hsn.forEach(x => console.log(`  • ${x.naam}  (lev: ${x.lev})`));
  console.log(`\n=== NON-FOOD (${nonfood.length}) ===`);
  nonfood.forEach(x => console.log(`  • ${x.naam}  (lev: ${x.lev || '—'})`));

  const teArchiveren = [...hsn, ...nonfood];
  console.log(`\n[cleanup] Totaal te archiveren: ${teArchiveren.length} | food behouden: ${active.length - teArchiveren.length}`);

  if (dryRun) { console.log('\n[cleanup] DRY-RUN — niets gewijzigd.'); return; }

  let ok = 0, fail = 0;
  for (const x of teArchiveren) {
    try { await notion.pages.update({ page_id: x.id, archived: true }); ok++; }
    catch (e) { fail++; console.error(`  ✗ ${x.naam}: ${e.message}`); }
  }
  console.log(`\n[cleanup] Klaar: ${ok} gearchiveerd, ${fail} mislukt.`);
})().catch(e => { console.error('[cleanup] Fout:', e.message); process.exit(1); });
