#!/usr/bin/env node
// Backfill van het Lightspeed (PosiOS) dagrapport over een reeks dagen.
// Gebruik:
//   node lightspeed-posios-backfill.js 30            # laatste 30 dagen
//   node lightspeed-posios-backfill.js 2026-05-01 2026-06-14   # datumbereik
//   ... --dry-run

const path = require('path');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
const { fetchPosiosDagrapport } = require('./src/lightspeed-posios');

let _sf = {};
try { _sf = JSON.parse(fs.readFileSync(path.join(__dirname, 'settings.json'), 'utf8')); } catch {}
const URL = _sf.supabaseUrl || process.env.SUPABASE_URL;
const KEY = _sf.supabaseKey || process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY;
const TOKEN = process.env.LS_POS_TOKEN || _sf.lsPosToken;
const dryRun = process.argv.includes('--dry-run');

function ymd(d) { return d.toISOString().split('T')[0]; }
function bouwDagen() {
  const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const dates = [];
  if (args.length >= 2 && /^\d{4}-\d{2}-\d{2}$/.test(args[0]) && /^\d{4}-\d{2}-\d{2}$/.test(args[1])) {
    for (let d = new Date(args[0]); d <= new Date(args[1]); d.setDate(d.getDate() + 1)) dates.push(ymd(new Date(d)));
  } else {
    const n = parseInt(args[0] || '30', 10);
    const end = new Date(); end.setDate(end.getDate() - 1); // t/m gisteren
    for (let i = n - 1; i >= 0; i--) { const d = new Date(end); d.setDate(end.getDate() - i); dates.push(ymd(d)); }
  }
  return dates;
}

async function run() {
  if (!TOKEN) { console.error('Geen lsPosToken'); process.exit(1); }
  const sb = (URL && KEY) ? createClient(URL, KEY) : null;
  if (!dryRun && !sb) { console.error('Supabase credentials ontbreken'); process.exit(1); }

  const dagen = bouwDagen();
  console.log(`\n=== PosiOS backfill — ${dagen.length} dagen (${dagen[0]} t/m ${dagen[dagen.length - 1]})${dryRun ? ' DRY-RUN' : ''} ===\n`);

  let ok = 0, leeg = 0, fout = 0;
  for (const datum of dagen) {
    try {
      const dr = await fetchPosiosDagrapport(datum, TOKEN);
      if (dr.totale_omzet == null && !dr.gerechten.length) { console.log(`  ${datum}: geen data`); leeg++; continue; }
      if (!dryRun) {
        const { error } = await sb.from('dagrapport').upsert({
          datum: dr.datum, restaurant: 'europizza',
          totale_omzet: dr.totale_omzet, bar_omzet: dr.bar_omzet, keuken_omzet: dr.keuken_omzet,
          aantal_gasten: dr.aantal_gasten, aantal_tafels: dr.aantal_tafels, gerechten: dr.gerechten,
        }, { onConflict: 'datum,restaurant' });
        if (error) { console.warn(`  ${datum}: schrijffout ${error.message}`); fout++; continue; }
      }
      console.log(`  ${datum}: €${dr.totale_omzet ?? '?'} excl · ${dr.aantal_gasten ?? '?'} gasten · ${dr.aantal_tafels ?? '?'} bonnen`);
      ok++;
    } catch (e) {
      if (e.authExpired) { console.error('  Token verlopen — stop. Vernieuw lsPosToken.'); process.exit(1); }
      console.warn(`  ${datum}: fout ${e.message}`); fout++;
    }
    await new Promise(r => setTimeout(r, 350)); // rate-limit vriendelijk
  }
  console.log(`\nKlaar: ${ok} opgeslagen · ${leeg} leeg · ${fout} fout`);
}

run().catch(e => { console.error('Fout:', e.message); process.exit(1); });
