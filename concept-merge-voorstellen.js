// Euro Food Monitor — Passard: stel concept-merges voor waar een prep-woord een dubbel concept maakte.
//
// "rauwe knoflook" en "knoflook" zijn hetzelfde product; door de exacte-naam-koppeling ontstonden
// daar twee concepten. Dit script vindt concepten waarvan de naam ná het strippen van een neutraal
// prep-woord (rauw/vers/gewassen/gepeld…) gelijk is aan een ANDER, bestaand concept, en stelt voor
// die samen te voegen. Conservatief: transformaties (gerookt/gedroogd/…) staan NIET in de lijst.
// Mens-in-de-lus: DRY-RUN toont de voorstellen, --sql print de merge-SQL voor de Supabase-editor.
//
//   node concept-merge-voorstellen.js          # DRY-RUN
//   node concept-merge-voorstellen.js --sql    # print de UPDATE/DELETE-SQL
//
// Merge S→T: inkoop_prijzen.concept_id herpunten, S's eenheid-kennis overzetten waar T 'm mist,
// dan S verwijderen. T (de basisnaam) blijft de waarheid.

require('dotenv').config();
const { conceptSleutel, PREP_VOORSTEL } = require('./src/recept-import-lib');
const SQL = process.argv.includes('--sql');
const sb = require('@supabase/supabase-js').createClient(
  process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY);

(async () => {
  if (!SQL) console.log('=== DRY-RUN — geen writes ===\n');
  const { data: concepten, error } = await sb.from('ingredient_concept').select('id, canonical_naam');
  if (error) { console.error('concept-tabel ontbreekt? draai zelflerend-fase-a-concept-laag.sql.', error.message); process.exit(1); }
  const { data: prijzen } = await sb.from('inkoop_prijzen').select('concept_id');
  const telPerConcept = {};
  for (const p of prijzen || []) if (p.concept_id) telPerConcept[p.concept_id] = (telPerConcept[p.concept_id] || 0) + 1;

  const idByNaam = {};
  for (const c of concepten || []) idByNaam[c.canonical_naam] = c.id;

  // Voorstel: concept S waarvan de gestripte sleutel een ANDER bestaand concept T is.
  const voorstellen = [];
  for (const S of concepten || []) {
    const key = conceptSleutel(S.canonical_naam, PREP_VOORSTEL);
    if (key === S.canonical_naam) continue;          // geen prep-woord → niets te mergen
    const tid = idByNaam[key];
    if (!tid || tid === S.id) continue;              // geen bestaand basisconcept om in te mergen
    voorstellen.push({ S, T: { id: tid, canonical_naam: key } });
  }

  if (!voorstellen.length) { console.log('Geen merge-voorstellen — geen "prep-woord"-dubbelen gevonden.'); return; }

  if (SQL) {
    console.log('-- Passard: voeg prep-dubbele concepten samen (bron S → doel T). Plak in de Supabase SQL-editor.');
    for (const { S, T } of voorstellen) {
      console.log(`-- "${S.canonical_naam}" → "${T.canonical_naam}"`);
      console.log(`update public.inkoop_prijzen set concept_id='${T.id}' where concept_id='${S.id}';`);
      console.log(`update public.concept_eenheid_kennis k set concept_id='${T.id}' where k.concept_id='${S.id}' and not exists (select 1 from public.concept_eenheid_kennis k2 where k2.concept_id='${T.id}' and k2.eenheid=k.eenheid);`);
      console.log(`delete from public.concept_eenheid_kennis where concept_id='${S.id}';`);
      console.log(`delete from public.ingredient_concept where id='${S.id}';`);
    }
    return;
  }

  console.log(`${voorstellen.length} merge-voorstel(len):\n`);
  for (const { S, T } of voorstellen) {
    console.log(`  • "${S.canonical_naam}" (${telPerConcept[S.id] || 0} rijen)  →  "${T.canonical_naam}" (${telPerConcept[T.id] || 0} rijen)`);
  }
  console.log('\nDraai met --sql voor de merge-SQL (review eerst).');
})();
