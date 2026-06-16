// Euro Food Monitor — Passard: concepten met meerdere geprijsde inkooprijen flaggen.
//
// Eén concept hoort één prijs te dragen. Meerdere ver-uiteenlopende prijzen binnen één concept zijn
// meestal een eenheid-/verpakkings-mismatch (de "10×-fout"), GEEN echte prijsvariatie. Dit script
// lijst ze — gesorteerd op spreiding — zodat jij per concept de juiste rij kiest
// (ingredient_concept.voorkeur_prijs_id). Blind aggregeren zou de calculatie slechter maken, dus dit
// is bewust mens-in-de-lus en read-only.
//
//   node concept-prijs-review.js

require('dotenv').config();
const sb = require('@supabase/supabase-js').createClient(
  process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY);

(async () => {
  const [{ data: prijzen }, { data: concepten }] = await Promise.all([
    sb.from('inkoop_prijzen').select('id, naam, eenheid, kostprijs, concept_id').not('concept_id', 'is', null).not('kostprijs', 'is', null),
    sb.from('ingredient_concept').select('id, canonical_naam, voorkeur_prijs_id'),
  ]);
  const conceptById = Object.fromEntries((concepten || []).map(c => [c.id, c]));
  const perConcept = {};
  for (const p of prijzen || []) (perConcept[p.concept_id] ||= []).push(p);

  const multi = Object.entries(perConcept)
    .filter(([, rows]) => rows.length > 1)
    .map(([cid, rows]) => {
      const bedragen = rows.map(r => r.kostprijs);
      const spread = Math.max(...bedragen) / Math.min(...bedragen);
      return { cid, rows, spread };
    })
    .sort((a, b) => b.spread - a.spread);

  if (!multi.length) { console.log('Geen concepten met meerdere geprijsde rijen.'); return; }

  const groot = multi.filter(m => m.spread >= 2).length;
  console.log(`${multi.length} concepten met meerdere geprijsde inkooprijen (${groot} met grote spreiding ≥2×):\n`);
  for (const { cid, rows, spread } of multi) {
    const c = conceptById[cid];
    const vlag = spread >= 2 ? '  ⚠ grote spreiding — mogelijk eenheid-mismatch' : '';
    const voorkeur = c?.voorkeur_prijs_id ? '  [voorkeur al gezet]' : '';
    console.log(`• ${c?.canonical_naam || cid}  (×${spread.toFixed(1)})${vlag}${voorkeur}`);
    for (const r of rows) {
      const ster = c?.voorkeur_prijs_id === r.id ? ' ★' : '';
      console.log(`    - € ${r.kostprijs}  ${(r.eenheid || '?').padEnd(6)}  "${r.naam}"  (id ${r.id})${ster}`);
    }
  }
  console.log('\nKies per concept de juiste rij en zet ingredient_concept.voorkeur_prijs_id = <id>.');
  console.log('(De grote-spreiding-gevallen zijn meestal eenheid-mismatches — controleer de eenheid.)');
})();
