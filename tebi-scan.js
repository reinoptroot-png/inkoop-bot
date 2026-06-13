#!/usr/bin/env node
// Tebi dagrapport scan — draait dagelijks om 07:30.
// Vernieuwt automatisch de access_token via de opgeslagen refresh_token.
// Eenmalige setup: node tebi-setup.js

const path = require('path');
const fs   = require('fs');
const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');
const { fetchTebiDayOverviewAuto, parseTebiDayOverview } = require('./src/tebi');

const SETTINGS = path.join(__dirname, 'settings.json');
let _sf = {};
try { _sf = JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch {}

const settings = {
  supabaseUrl:      _sf.supabaseUrl                 || process.env.SUPABASE_URL,
  supabaseKey:      _sf.supabaseKey                 || process.env.SUPABASE_KEY,
  tebiToken:        process.env.TEBI_TOKEN          || _sf.tebiToken,
  tebiRefreshToken: process.env.TEBI_REFRESH_TOKEN  || _sf.tebiRefreshToken,
};

if (!settings.tebiToken && !settings.tebiRefreshToken) {
  console.error('[tebi-scan] Geen Tebi token gevonden — run eerst: node tebi-setup.js');
  process.exit(1);
}
if (!settings.supabaseUrl || !settings.supabaseKey) {
  console.error('[tebi-scan] Supabase credentials ontbreken');
  process.exit(1);
}

function gisteren() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
}

async function run() {
  const datum = process.argv[2] || gisteren();
  console.log(`\n=== Tebi dagrapport scan — ${new Date().toISOString()} ===`);
  console.log(`Datum: ${datum}`);

  let rawData;
  try {
    rawData = await fetchTebiDayOverviewAuto(datum, settings);
  } catch (e) {
    console.error('[tebi-scan] Fout:', e.message);
    process.exit(1);
  }

  if (!rawData) {
    console.log(`[tebi-scan] Geen data voor ${datum} (gesloten of geen omzet).`);
    process.exit(0);
  }

  const dr = parseTebiDayOverview(rawData, datum);
  if (!dr) {
    console.error('[tebi-scan] Kon dagrapport niet parsen');
    process.exit(1);
  }

  console.log(`Omzet: €${dr.totale_omzet ?? '?'} | Gasten: ${dr.aantal_gasten ?? '?'} | Tafels: ${dr.aantal_tafels ?? '?'} | Gerechten: ${dr.gerechten.length}`);

  const sb = createClient(settings.supabaseUrl, settings.supabaseKey, { global: { WebSocket: ws } });
  const { error } = await sb.from('dagrapport').upsert({
    datum: dr.datum, restaurant: 'europa',
    totale_omzet: dr.totale_omzet, bar_omzet: dr.bar_omzet, keuken_omzet: dr.keuken_omzet,
    aantal_gasten: dr.aantal_gasten, aantal_tafels: dr.aantal_tafels, gerechten: dr.gerechten,
  }, { onConflict: 'datum,restaurant' });

  if (error) { console.error('[tebi-scan] Supabase schrijffout:', error.message); process.exit(1); }

  console.log(`[tebi-scan] dagrapport ${datum} (restaurant=europa) opgeslagen — ${dr.gerechten.length} gerechten`);
  fs.appendFileSync(
    path.join(__dirname, 'tebi-scan-log.txt'),
    `${new Date().toISOString()} — ${datum} | €${dr.totale_omzet ?? '?'} | ${dr.aantal_gasten ?? '?'} gasten\n`
  );
}

run().catch(e => {
  console.error('\n[tebi-scan] Onverwachte fout:', e.message);
  process.exit(1);
});
