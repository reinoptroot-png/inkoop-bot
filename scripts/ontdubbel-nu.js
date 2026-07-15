#!/usr/bin/env node
// Eenmalige (her-runbare) ontdubbel-run: draait notion.autoMerge(supabase) los van de scan.
// Sinds criterium C voegt die ook rijen met hetzelfde leverancier+artikelnr samen (de wortel
// onder "kruisbes had 3 prijzen"), en hangt hij receptuur-verwijzingen in Supabase om.
// Daarna een mirror zodat Supabase meteen het opgeschoonde assortiment toont.
//   node scripts/ontdubbel-nu.js
require('dotenv').config({ path: __dirname + '/../.env', quiet: true });
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const NotionSync = require('../src/notion-sync');

let _sf = {};
try { _sf = JSON.parse(fs.readFileSync(path.join(__dirname, '../settings.json'), 'utf8')); } catch {}
const settings = {
  notionToken: process.env.NOTION_TOKEN || _sf.notionToken,
  notionDbId: process.env.NOTION_DB_ID || _sf.notionDbId || 'b6258a232e6d4482b7b4f50cf449854f',
  anthropicKey: process.env.ANTHROPIC_KEY || process.env.ANTHROPIC_API_KEY || _sf.anthropicKey,
  supabaseUrl: process.env.SUPABASE_URL || _sf.supabaseUrl,
  supabaseKey: process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || _sf.supabaseKey,
};

(async () => {
  const notion = new NotionSync(settings);
  const sb = createClient(settings.supabaseUrl, settings.supabaseKey);
  console.log('=== auto-merge (incl. artikelnr-criterium) ===');
  const am = await notion.autoMerge(sb);
  console.log(`\n${am.merged} dubbel(en) samengevoegd.`);
  console.log('\n=== mirror naar Supabase ===');
  const m = await notion.mirrorNaarSupabase(sb);
  console.log(m?.error ? 'mirror-fout: ' + m.error : `${m?.count} ingrediënten gespiegeld.`);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
