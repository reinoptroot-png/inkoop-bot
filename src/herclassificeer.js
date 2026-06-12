/**
 * Eenmalige herclassificatie: haalt ALLE actieve ingrediënten opnieuw door
 * Claude Haiku en werkt de Categorie in Notion + Supabase bij (alleen waar die
 * verandert). `Is drank` wordt NIET aangepast (om geen food per ongeluk te
 * verbergen). Draai met --dry-run om alleen te tonen wat zou wijzigen.
 *
 * Gebruik: node src/herclassificeer.js [--dry-run]
 */
require('dotenv').config();
const { Client } = require('@notionhq/client');
const NotionSync = require('./notion-sync');
const { createClient } = require('@supabase/supabase-js');

(async () => {
  const dryRun = process.argv.includes('--dry-run');
  const settings = {
    notionToken: process.env.NOTION_TOKEN,
    notionDbId: process.env.NOTION_DB_ID || 'b6258a232e6d4482b7b4f50cf449854f',
    anthropicKey: process.env.ANTHROPIC_KEY,
  };
  if (!settings.notionToken || !settings.anthropicKey) {
    console.error('[herclassificeer] NOTION_TOKEN en ANTHROPIC_KEY vereist'); process.exit(1);
  }
  const notion = new NotionSync(settings);
  const client = new Client({ auth: settings.notionToken });

  const prices = await notion.getAllPrices(); // {pageId, name, categorie, isDrank, ...}
  console.log(`[herclassificeer] ${prices.length} actieve ingrediënten${dryRun ? ' (DRY-RUN)' : ''}`);

  const classified = await notion.classify(prices.map(p => ({ ingredient: p.name })));
  const byName = {};
  for (const c of classified) byName[(c.original || '').toLowerCase().trim()] = c;

  let gewijzigd = 0, ongewijzigd = 0, geenClassificatie = 0;
  for (const p of prices) {
    const c = byName[p.name];
    const nieuweCat = c && c.categorie;
    if (!nieuweCat) { geenClassificatie++; continue; }
    if (nieuweCat === (p.categorie || '')) { ongewijzigd++; continue; }
    console.log(`  ${p.name}: ${p.categorie || '—'} → ${nieuweCat}`);
    gewijzigd++;
    if (!dryRun) {
      try {
        await client.pages.update({ page_id: p.pageId, properties: { 'Categorie': { select: { name: nieuweCat } } } });
      } catch (e) { console.warn(`  ! ${p.name}: ${e.message}`); }
    }
  }
  console.log(`[herclassificeer] ${gewijzigd} ${dryRun ? 'zouden wijzigen' : 'gewijzigd'}, ${ongewijzigd} ongewijzigd, ${geenClassificatie} zonder classificatie`);

  if (!dryRun && process.env.SUPABASE_URL && (process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY)) {
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY);
    const m = await notion.mirrorNaarSupabase(sb);
    console.log(`[herclassificeer] ${m?.count ?? 0} ingrediënten gespiegeld naar Supabase`);
  }
})().catch(e => { console.error('[herclassificeer] Fout:', e.message); process.exit(1); });
