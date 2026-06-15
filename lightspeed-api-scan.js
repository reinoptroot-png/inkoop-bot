#!/usr/bin/env node
// Lightspeed dagrapport scan via REST API — draait dagelijks via GitHub Actions (08:00 CEST).
// Vervangt het e-mail/IMAP-pad (lightspeed-scan.yml) dat geblokkeerd werd door one.com.
//
// Setup: node lightspeed-api-setup.js  (eenmalig — zet refresh_token in Supabase)
// Handmatig: node lightspeed-api-scan.js 2026-06-14

const path = require('path');
const fs   = require('fs');
const { createClient } = require('@supabase/supabase-js');
const { fetchLsDayOverviewAuto, refreshLsToken, parseLsDayOverview } = require('./src/lightspeed-api');

const SETTINGS_FILE = path.join(__dirname, 'settings.json');
let _sf = {};
try { _sf = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch {}

const settings = {
  supabaseUrl:          _sf.supabaseUrl               || process.env.SUPABASE_URL,
  supabaseKey:          _sf.supabaseKey               || process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY,
  lsClientId:           _sf.lsClientId               || process.env.LS_CLIENT_ID,
  lsClientSecret:       _sf.lsClientSecret           || process.env.LS_CLIENT_SECRET,
  lsBusinessLocationId: _sf.lsBusinessLocationId     || Number(process.env.LS_BUSINESS_LOCATION_ID) || 0,
  lsRefreshToken:       _sf.lsRefreshToken           || process.env.LS_REFRESH_TOKEN || '',
  lsAccessToken:        _sf.lsAccessToken            || '',
};

async function loadRefreshToken(sb) {
  const { data } = await sb.from('instellingen')
    .select('value')
    .eq('restaurant', 'europizza')
    .eq('key', 'ls_refresh_token')
    .maybeSingle();
  return data?.value || '';
}

async function saveRefreshToken(sb, token) {
  if (!token) return;
  await sb.from('instellingen').upsert(
    { restaurant: 'europizza', key: 'ls_refresh_token', value: token, updated_at: new Date().toISOString() },
    { onConflict: 'restaurant,key' }
  );
}

async function saveScanTijd(sb) {
  await sb.from('instellingen').upsert(
    { restaurant: 'europizza', key: 'ls_laatste_scan', value: new Date().toISOString(), updated_at: new Date().toISOString() },
    { onConflict: 'restaurant,key' }
  );
}

function gisteren() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
}

async function run() {
  const datum = process.argv[2] || gisteren();
  console.log(`\n=== Lightspeed API scan — ${new Date().toISOString()} ===`);
  console.log(`Datum: ${datum}`);

  if (!settings.supabaseUrl || !settings.supabaseKey) {
    console.error('[ls-scan] Supabase credentials ontbreken');
    process.exit(1);
  }
  if (!settings.lsClientId || !settings.lsClientSecret) {
    console.error('[ls-scan] LS_CLIENT_ID of LS_CLIENT_SECRET ontbreekt — voeg toe als GitHub secret');
    process.exit(1);
  }
  if (!settings.lsBusinessLocationId) {
    console.error('[ls-scan] LS_BUSINESS_LOCATION_ID ontbreekt');
    process.exit(1);
  }

  const sb = createClient(settings.supabaseUrl, settings.supabaseKey);

  // refresh_token uit Supabase laden (primair) of settings.json (fallback)
  const storedRefreshToken = await loadRefreshToken(sb);
  if (storedRefreshToken) {
    settings.lsRefreshToken = storedRefreshToken;
  }
  if (!settings.lsRefreshToken) {
    console.error('[ls-scan] Geen refresh_token gevonden — run eerst: node lightspeed-api-setup.js');
    process.exit(1);
  }

  // Token vernieuwen zodat we altijd met een verse access_token werken
  let refreshResult;
  try {
    refreshResult = await refreshLsToken(settings);
    settings.lsAccessToken  = refreshResult.accessToken;
    settings.lsRefreshToken = refreshResult.refreshToken;
    await saveRefreshToken(sb, refreshResult.refreshToken);
    console.log('[ls-scan] access_token vernieuwd');
  } catch (e) {
    console.error('[ls-scan] Token refresh mislukt:', e.message);
    process.exit(1);
  }

  // Verkoopdata ophalen
  let rawData;
  try {
    rawData = await fetchLsDayOverviewAuto(datum, settings);
  } catch (e) {
    console.error('[ls-scan] API fout:', e.message);
    process.exit(1);
  }

  if (!rawData || !(rawData.sales?.length)) {
    console.log(`[ls-scan] Geen verkoopdata voor ${datum} (gesloten of geen omzet).`);
    await saveScanTijd(sb);
    process.exit(0);
  }

  const dr = parseLsDayOverview(rawData, datum);
  if (!dr) {
    console.error('[ls-scan] Kon dagrapport niet parsen');
    process.exit(1);
  }

  console.log(`Omzet: €${dr.totale_omzet ?? '?'} | Gasten: ${dr.aantal_gasten ?? '?'} | Tafels: ${dr.aantal_tafels ?? '?'} | Gerechten: ${dr.gerechten.length} | Volledig: ${dr.data_volledig}`);

  const { error } = await sb.from('dagrapport').upsert({
    datum:          dr.datum,
    restaurant:     'europizza',
    totale_omzet:   dr.totale_omzet,
    bar_omzet:      dr.bar_omzet,
    keuken_omzet:   dr.keuken_omzet,
    aantal_gasten:  dr.aantal_gasten,
    aantal_tafels:  dr.aantal_tafels,
    gerechten:      dr.gerechten,
  }, { onConflict: 'datum,restaurant' });

  if (error) {
    console.error('[ls-scan] Supabase schrijffout:', error.message);
    process.exit(1);
  }

  await saveScanTijd(sb);
  console.log(`[ls-scan] dagrapport ${datum} (restaurant=europizza) opgeslagen — ${dr.gerechten.length} gerechten`);

  fs.appendFileSync(
    path.join(__dirname, 'lightspeed-api-scan-log.txt'),
    `${new Date().toISOString()} — ${datum} | €${dr.totale_omzet ?? '?'} | ${dr.aantal_gasten ?? '?'} gasten | ${dr.gerechten.length} gerechten\n`
  );
}

run().catch(e => {
  console.error('\n[ls-scan] Onverwachte fout:', e.message);
  process.exit(1);
});
