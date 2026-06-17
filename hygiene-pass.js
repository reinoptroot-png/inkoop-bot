// Euro Food Monitor — Passard: datahygiëne-pass (read-only diagnostiek).
//
// Rommel onderin de data (prijs 0, eenheid-in-naam, incomplete bereidingen, niet-doorgeprijsd)
// vervuilt stil de foodcost bovenin. Dit script lijst die gevallen als VOORSTEL ter bevestiging —
// het wijzigt niets. Echte FC%-uitschieters per gerecht toont de Fase-2 betrouwbaarheidsmeter al
// in de calculator (die heeft de webapp-costinglogica nodig); hier flaggen we de databron-rot.
//
//   node hygiene-pass.js
//
// Bewust read-only en mens-in-de-lus (zoals concept-prijs-review.js): correcties doe je gericht,
// niet blind in bulk.
require('dotenv').config();
const sb = require('@supabase/supabase-js').createClient(
  process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY);

// Namen waarbij prijs 0 legitiem is (gratis/water).
const PRIJS0_OK = /\b(water|kraanwater|leidingwater|ijs|ice)\b/i;
// Eenheid/typo lekt in de naam (de naam hoort het concept te zijn, niet de verpakking).
const EENHEID_IN_NAAM = /\b\d+\s?(kg|kilo|gram|gr|ml|cl|ltr|liter)\b|\bmililiter\b|\bsuk\b/i;

const num = (v) => (v == null || v === '' ? null : parseFloat(String(v).replace(',', '.')));

(async () => {
  const [{ data: prijzen }, { data: bereidingen }, { data: kostprijzen }] = await Promise.all([
    sb.from('inkoop_prijzen').select('id, naam, kostprijs, eenheid, categorie'),
    sb.from('bereiding').select('id, locatie, is_incompleet, eind_yield, status, goedgekeurd, canonical_bereiding(canonical_naam)'),
    sb.from('bereiding_kostprijs').select('bereiding_id, prijs_per_eenheid, batch_totaal_kost, geschat'),
  ]);
  const naamVan = (b) => b.canonical_bereiding?.canonical_naam || `bereiding ${b.id}`;
  const kostBij = Object.fromEntries((kostprijzen || []).map((k) => [k.bereiding_id, k]));

  // 1) Prijs 0 / ontbrekend (excl. legitiem gratis).
  const prijs0 = (prijzen || []).filter((p) => {
    const k = num(p.kostprijs);
    return (k == null || k === 0) && !PRIJS0_OK.test(p.naam || '');
  });

  // 2) Eenheid/typo in de naam.
  const naamRot = (prijzen || []).filter((p) => EENHEID_IN_NAAM.test(p.naam || ''));

  // 3) Incomplete / yield-loze bereidingen (kunnen niet betrouwbaar gecost worden).
  //    Splits: GOEDGEKEURD = urgent (telt mee in de calc), archief = verwacht (alleen tellen).
  const isKapotIncompleet = (b) => b.is_incompleet || num(b.eind_yield) === 0 || b.eind_yield == null;
  const incompleet = (bereidingen || []).filter(isKapotIncompleet);
  const incompleetGoedgekeurd = incompleet.filter((b) => b.goedgekeurd);
  const incompleetArchief = incompleet.length - incompleetGoedgekeurd.length;

  // 4) Bereidingen zonder doorgerekende prijs (gat in de costing). Idem: alleen goedgekeurd is urgent.
  const isNietGecost = (b) => b.status !== 'methode'
    && (() => { const k = kostBij[b.id]; return !k || num(k.prijs_per_eenheid) == null || num(k.prijs_per_eenheid) === 0; })();
  const nietGecost = (bereidingen || []).filter(isNietGecost);
  const nietGecostGoedgekeurd = nietGecost.filter((b) => b.goedgekeurd);
  const nietGecostArchief = nietGecost.length - nietGecostGoedgekeurd.length;

  const sectie = (titel, items, render) => {
    console.log(`\n## ${titel} — ${items.length}`);
    if (!items.length) { console.log('   (geen)'); return; }
    for (const it of items.slice(0, 40)) console.log('   • ' + render(it));
    if (items.length > 40) console.log(`   … en nog ${items.length - 40}`);
  };

  console.log('=== Passard hygiënepass (read-only) ===');
  console.log('Databron-rot (geldt altijd):');
  sectie('Prijs 0 / ontbrekend', prijs0, (p) => `${p.naam}  (€ ${p.kostprijs ?? '—'} / ${p.eenheid || '?'})  [id ${p.id}]`);
  sectie('Eenheid of typo in de naam', naamRot, (p) => `"${p.naam}"  → naam hoort het concept te zijn, niet de verpakking  [id ${p.id}]`);

  console.log('\nVervuilt de calculatie (alleen GOEDGEKEURDE recepten tellen mee):');
  sectie('Incompleet/yield-loos & goedgekeurd', incompleetGoedgekeurd, (b) => `${naamVan(b)}  (${b.is_incompleet ? 'incompleet ' : ''}eind_yield ${b.eind_yield ?? 'null'})`);
  sectie('Niet-doorgeprijsd & goedgekeurd', nietGecostGoedgekeurd, (b) => `${naamVan(b)}  [${b.status || '?'}]`);

  console.log('\n=== Samenvatting ===');
  console.log(`  prijs 0/ontbrekend:              ${prijs0.length}`);
  console.log(`  eenheid/typo in naam:            ${naamRot.length}`);
  console.log(`  incompleet (goedgekeurd/totaal): ${incompleetGoedgekeurd.length} / ${incompleet.length}  (${incompleetArchief} archief — verwacht)`);
  console.log(`  niet-gecost (goedgekeurd/totaal): ${nietGecostGoedgekeurd.length} / ${nietGecost.length}  (${nietGecostArchief} archief — verwacht)`);
  console.log('\nRead-only — corrigeer gericht (geen bulk). Goedgekeurde gevallen tellen mee in de FC: die eerst.');
  console.log('Echte FC%-uitschieters per gerecht: zie het betrouwbaarheidssignaal (Fase 2) in de calculator.');
})().catch((e) => { console.error('FOUT:', e.message); process.exit(1); });
