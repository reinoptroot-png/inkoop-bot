#!/usr/bin/env node
// Lightspeed L-Series (PosiOS) dagrapport scan — net als tebi-scan.js.
// Haalt het dagrapport op via de browser-sessie-token (lsPosToken) en schrijft
// het naar Supabase `dagrapport` (restaurant='europizza').
//
// Token éénmalig overnemen uit de ingelogde backoffice: open
// https://euc2-web.posios.com → DevTools → Application → Session Storage →
// key `apitoken`, en zet die als lsPosToken in settings.json (of env LS_POS_TOKEN).
//
// Gebruik:
//   node lightspeed-posios-scan.js            # gisteren
//   node lightspeed-posios-scan.js 2026-06-12 # specifieke datum
//   node lightspeed-posios-scan.js --dry-run  # niet naar Supabase schrijven

const path = require('path');
const fs   = require('fs');
const { createClient } = require('@supabase/supabase-js');
const { fetchPosiosDagrapport } = require('./src/lightspeed-posios');

const SETTINGS = path.join(__dirname, 'settings.json');
let _sf = {};
try { _sf = JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch {}

const settings = {
  supabaseUrl: _sf.supabaseUrl || process.env.SUPABASE_URL,
  supabaseKey: _sf.supabaseKey || process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY,
  lsPosToken:  process.env.LS_POS_TOKEN || _sf.lsPosToken,
};

const dryRun = process.argv.includes('--dry-run');
const dateArg = process.argv.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a));

function gisteren() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
}

// Token-fallback: in Supabase instellingen (restaurant=europizza, key=ls_pos_token).
async function laadToken(sb) {
  if (settings.lsPosToken) return settings.lsPosToken;
  if (!sb) return null;
  try {
    const { data } = await sb.from('instellingen').select('value')
      .eq('restaurant', 'europizza').eq('key', 'ls_pos_token').single();
    return data?.value || null;
  } catch { return null; }
}

async function run() {
  const datum = dateArg || gisteren();
  console.log(`\n=== Lightspeed (PosiOS) dagrapport scan — ${new Date().toISOString()} ===`);
  console.log(`Datum: ${datum}${dryRun ? ' (DRY-RUN)' : ''}`);

  const sb = (settings.supabaseUrl && settings.supabaseKey)
    ? createClient(settings.supabaseUrl, settings.supabaseKey) : null;

  const token = await laadToken(sb);
  if (!token) {
    console.error('[ls-posios] Geen lsPosToken — neem de apitoken over uit de ingelogde backoffice (zie kop van dit script).');
    process.exit(1);
  }

  let dr;
  try {
    dr = await fetchPosiosDagrapport(datum, token);
  } catch (e) {
    if (e.authExpired) {
      console.error('[ls-posios] Token verlopen — log opnieuw in op de backoffice en vernieuw lsPosToken in settings.json.');
    } else {
      console.error('[ls-posios] Fout:', e.message);
    }
    process.exit(1);
  }

  if (dr.totale_omzet == null && (!dr.gerechten || !dr.gerechten.length)) {
    console.log(`[ls-posios] Geen data voor ${datum} (gesloten of geen omzet).`);
    process.exit(0);
  }

  console.log(`Omzet excl: €${dr.totale_omzet ?? '?'} | Keuken: €${dr.keuken_omzet ?? '?'} | Bar: €${dr.bar_omzet ?? '?'}`);
  console.log(`Gasten: ${dr.aantal_gasten ?? '?'} | Bonnen: ${dr.aantal_tafels ?? '?'} | Categorieën: ${dr.gerechten.length}`);

  if (dryRun) {
    console.log('\n[ls-posios] DRY-RUN — niet naar Supabase geschreven. Gerechten:');
    dr.gerechten.slice(0, 12).forEach(g => console.log(`  ${g.type}  ${g.naam}: €${g.totaal}`));
    return;
  }
  if (!sb) { console.error('[ls-posios] Supabase credentials ontbreken — kan niet schrijven.'); process.exit(1); }

  const { error } = await sb.from('dagrapport').upsert({
    datum: dr.datum, restaurant: 'europizza',
    totale_omzet: dr.totale_omzet, bar_omzet: dr.bar_omzet, keuken_omzet: dr.keuken_omzet,
    aantal_gasten: dr.aantal_gasten, aantal_tafels: dr.aantal_tafels, gerechten: dr.gerechten,
  }, { onConflict: 'datum,restaurant' });

  if (error) { console.error('[ls-posios] Supabase schrijffout:', error.message); process.exit(1); }

  console.log(`[ls-posios] dagrapport ${datum} (restaurant=europizza) opgeslagen — ${dr.gerechten.length} categorieën`);
  try {
    fs.appendFileSync(path.join(__dirname, 'lightspeed-posios-scan-log.txt'),
      `${new Date().toISOString()} — ${datum} | €${dr.totale_omzet ?? '?'} excl | ${dr.aantal_gasten ?? '?'} gasten\n`);
  } catch {}
}

run().catch(e => { console.error('\n[ls-posios] Onverwachte fout:', e.message); process.exit(1); });
