#!/usr/bin/env node
// Tebi dagrapport scan — draait dagelijks om 07:30.
// Haalt het dagrapport van gisteren op via de Tebi Bearer-token API en slaat op in Supabase.
// Vereist: tebiToken in settings.json of env var TEBI_TOKEN.
// Token ophalen: DevTools → Network → XHR op live.tebi.co/api/ → Authorization header.

const path = require('path');
const fs   = require('fs');
const { createClient } = require('@supabase/supabase-js');
const { fetchTebiDayOverview, parseTebiDayOverview } = require('./src/tebi');

let _sf = {};
try { _sf = JSON.parse(fs.readFileSync(path.join(__dirname, 'settings.json'), 'utf8')); } catch {}

const settings = {
  supabaseUrl: process.env.SUPABASE_URL  || _sf.supabaseUrl,
  supabaseKey: process.env.SUPABASE_KEY  || _sf.supabaseKey,
  tebiToken:   process.env.TEBI_TOKEN    || _sf.tebiToken,
};

if (!settings.tebiToken) {
  console.error('[tebi-scan] tebiToken ontbreekt — voeg toe aan settings.json of stel TEBI_TOKEN in');
  console.error('  Ophalen: open live.tebi.co → DevTools → Network → XHR → Authorization: Bearer <token>');
  process.exit(1);
}
if (!settings.supabaseUrl || !settings.supabaseKey) {
  console.error('[tebi-scan] Supabase credentials ontbreken');
  process.exit(1);
}

// Datum van gisteren (YYYY-MM-DD)
function gisteren() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
}

async function run() {
  const datum = process.argv[2] || gisteren(); // optioneel: node tebi-scan.js 2026-06-12
  console.log(`\n=== Tebi dagrapport scan — ${new Date().toISOString()} ===`);
  console.log(`Datum: ${datum}`);

  let rawData;
  try {
    rawData = await fetchTebiDayOverview(datum, settings.tebiToken);
  } catch (e) {
    if (/auth mislukt|401|403/i.test(e.message)) {
      console.log('[tebi-scan] Token verlopen — ververs tebiToken in settings.json. Overgeslagen.');
      process.exit(0); // geen error, cron blijft stil
    }
    console.error('[tebi-scan] Fetch fout:', e.message);
    process.exit(1);
  }

  if (!rawData) {
    console.log(`[tebi-scan] Geen data voor ${datum} (gesloten of geen omzet).`);
    process.exit(0);
  }

  const dr = parseTebiDayOverview(rawData, datum);
  if (!dr) {
    console.error('[tebi-scan] Kon dagrapport niet parsen — onbekende response-structuur');
    console.error('Raw:', JSON.stringify(rawData, null, 2).slice(0, 500));
    process.exit(1);
  }

  console.log(`Omzet: €${dr.totale_omzet ?? '?'} | Gasten: ${dr.aantal_gasten ?? '?'} | Tafels: ${dr.aantal_tafels ?? '?'} | Gerechten: ${dr.gerechten.length}`);

  const sb = createClient(settings.supabaseUrl, settings.supabaseKey);
  const { error } = await sb.from('dagrapport').upsert({
    datum:         dr.datum,
    restaurant:    'europa',
    totale_omzet:  dr.totale_omzet,
    bar_omzet:     dr.bar_omzet,
    keuken_omzet:  dr.keuken_omzet,
    aantal_gasten: dr.aantal_gasten,
    aantal_tafels: dr.aantal_tafels,
    gerechten:     dr.gerechten,
  }, { onConflict: 'datum,restaurant' });

  if (error) {
    console.error('[tebi-scan] Supabase schrijffout:', error.message);
    process.exit(1);
  }

  console.log(`[tebi-scan] dagrapport ${datum} (restaurant=europa) opgeslagen — ${dr.gerechten.length} gerechten`);
  fs.appendFileSync(
    path.join(__dirname, 'tebi-scan-log.txt'),
    `${new Date().toISOString()} — ${datum} | €${dr.totale_omzet ?? '?'} | ${dr.aantal_gasten ?? '?'} gasten\n`
  );
}

run().catch(e => {
  console.error('\n[tebi-scan] Onverwachte fout:', e.message);
  console.error(e.stack);
  process.exit(1);
});
