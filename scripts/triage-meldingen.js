'use strict';
// Triage van openstaande scan_meldingen na de prijs-per-kg fix (circa-kruiden) en
// het canonical-systeem. Veel `prijs_groot` meldingen zijn geen echte prijs-
// wijzigingen maar per-kg-normalisatie-artefacten op producten die per stuk/bos
// worden ingekocht (een bosje "tijm circa 70 gram" omgerekend naar €/kg = +1328%).
//
// Die moeten NEGEERD worden (niet accepteren — accepteren zou de foute kiloprijs
// naar Notion schrijven; de oude per-stuk prijs is juist).
//
// Dit script classificeert pending `prijs_groot` als:
//   - artefact  → status 'ignored' (oude prijs blijft staan)
//   - review    → laat staan (mogelijk echte prijswijziging)
//
// Gebruik:
//   node scripts/triage-meldingen.js            # dry-run, toont classificatie
//   node scripts/triage-meldingen.js --apply    # zet artefacten op 'ignored'

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

let _sf = {};
try { _sf = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'settings.json'), 'utf8')); } catch {}
const URL = _sf.supabaseUrl || process.env.SUPABASE_URL;
const KEY = _sf.supabaseKey || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
const apply = process.argv.includes('--apply');

// Klein gewicht/volume in de naam (bosje/portie) → per-kg omrekening is een artefact.
function kleinGewichtInNaam(naam) {
  const n = String(naam || '').toLowerCase();
  if (/circa/.test(n)) return true;
  const m = n.match(/(\d+(?:[.,]\d+)?)\s*(gram|gr|g|ml|cl|l|liter|ltr)\b/);
  if (!m) return false;
  let v = parseFloat(m[1].replace(',', '.'));
  const u = m[2];
  if (/^(l|liter|ltr)$/.test(u)) v *= 1000;       // liter → gram-equiv
  else if (u === 'cl') v *= 10;
  else if (/^(kg)$/.test(u)) v *= 1000;
  // klein = onder 1000 g/ml → per stuk/bos ingekocht
  return v > 0 && v < 1000;
}

async function run() {
  if (!URL || !KEY) { console.error('Supabase credentials ontbreken'); process.exit(1); }
  const sb = createClient(URL, KEY);

  const { data, error } = await sb.from('scan_meldingen')
    .select('id,ingredient_naam,prijs_oud,prijs_nieuw,wijziging_pct')
    .eq('type', 'prijs_groot').eq('status', 'pending');
  if (error) { console.error('Laden mislukt:', error.message); process.exit(1); }

  const artefacten = [], review = [];
  for (const m of data) {
    const pct = Number(m.wijziging_pct || 0);
    // Artefact: klein gewicht in naam én grote opwaartse sprong (per stuk → per kg).
    const isArtefact = kleinGewichtInNaam(m.ingredient_naam) && pct >= 150;
    (isArtefact ? artefacten : review).push(m);
  }

  console.log(`\n=== Triage prijs_groot (pending: ${data.length}) ${apply ? '— APPLY' : '(dry-run)'} ===\n`);
  console.log(`ARTEFACT → negeren (${artefacten.length}):`);
  artefacten.forEach(m => console.log(`  ${m.ingredient_naam}: €${m.prijs_oud}→€${m.prijs_nieuw} (${Math.round(m.wijziging_pct)}%)`));
  console.log(`\nREVIEW → laten staan (${review.length}):`);
  review.forEach(m => console.log(`  ${m.ingredient_naam}: €${m.prijs_oud}→€${m.prijs_nieuw} (${Math.round(m.wijziging_pct)}%)`));

  if (!apply) { console.log('\nDraai met --apply om de artefacten op \x27ignored\x27 te zetten.'); return; }
  if (artefacten.length) {
    const { error: upErr } = await sb.from('scan_meldingen')
      .update({ status: 'ignored', gelezen: true })
      .in('id', artefacten.map(m => m.id));
    if (upErr) { console.error('Update mislukt:', upErr.message); process.exit(1); }
    console.log(`\n✅ ${artefacten.length} artefact-meldingen op 'ignored' gezet (oude prijs blijft).`);
  }
}

run().catch(e => { console.error('Fout:', e.message); process.exit(1); });
