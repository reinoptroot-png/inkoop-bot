// Receptencomposer — snelle review-koppelaar (Supabase-only, geen Notion).
//
// Loopt over de openstaande bereiding_import_review-regels en probeert ze alsnog te
// koppelen: eerst matchLokaal (exact/alias/Jaccard), anders Haiku-fallback. Bij een match
// wordt een bereiding_component aangemaakt, de receptnaam als alias op het ingredient
// geleerd, en de review-regel op 'gekoppeld' gezet. Dit is wat import-recepten.js ook doet,
// maar zónder alle Notion-pagina's opnieuw in te lezen (dat veroorzaakte de traagheid/timeouts).
//
//   node koppel-review.js            # DRY-RUN (geen writes)
//   node koppel-review.js --commit   # schrijft componenten + aliassen + status

let s = {}; try { s = require('./settings.json'); } catch (e) {}
require('dotenv').config();
// Haal de werkende ANTHROPIC_API_KEY ook op uit de calculator's .env.local (heeft credits).
require('dotenv').config({ path: require('path').join(__dirname, '../../europizza-calculator/.env.local'), override: false });
const { matchLokaal, normNaam } = require('./src/recept-import-lib');
const { matchRegelViaHaiku } = require('./src/bereiding-match');

const COMMIT = process.argv.includes('--commit');
const anthropicKey = process.env.ANTHROPIC_API_KEY || s.anthropicKey;
const USE_HAIKU = !process.argv.includes('--no-haiku') && !!anthropicKey;
// Trechtermond: alleen HOGE-confidence auto-koppelen; twijfel blijft review (mens bevestigt
// in de composer). Voorkomt foute auto-koppelingen (zoals "lams botten" ↔ "lams zwezerik").
// --alles herstelt het oude gedrag (koppel alles wat matcht).
const KOPPEL_ALLES = process.argv.includes('--alles');
const AUTO_LOKAAL = 0.8;   // token-Jaccard-drempel voor auto (exact/alias = 1 → altijd auto)
const AUTO_HAIKU = 0.90;   // Haiku-confidence-drempel voor auto
function isZeker(d) {
  if (!d || !d.m) return false;
  if (KOPPEL_ALLES) return true;
  return d.bron === 'haiku' ? d.m.score >= AUTO_HAIKU : d.m.score >= AUTO_LOKAAL;
}
const sb = require('@supabase/supabase-js').createClient(
  process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY);

async function leerAlias(ingredientId, receptNaam, index) {
  const doel = normNaam(receptNaam);
  if (!doel) return false;
  const inMem = index.find(c => c.id === ingredientId);
  if (inMem && (inMem.namen || []).some(n => normNaam(n) === doel)) return false;
  if (COMMIT) {
    const { data: row } = await sb.from('inkoop_prijzen').select('aliassen').eq('id', ingredientId).single();
    const best = String(row?.aliassen || '').split(',').map(x => x.trim()).filter(Boolean);
    if (best.some(a => normNaam(a) === doel)) return false;
    best.push(receptNaam.trim());
    await sb.from('inkoop_prijzen').update({ aliassen: best.join(', ') }).eq('id', ingredientId);
  }
  if (inMem) inMem.namen.push(receptNaam.trim());
  return true;
}

(async () => {
  console.log(COMMIT ? '=== COMMIT — schrijft ===' : '=== DRY-RUN — geen writes ===');
  console.log(USE_HAIKU ? '(Haiku-fallback actief)\n' : '(geen Haiku — alleen lokaal)\n');

  // Index uit Supabase (geen Notion).
  const { data: ingRows } = await sb.from('inkoop_prijzen').select('id, naam, canonical_naam, aliassen');
  const ingredientIndex = (ingRows || []).map(r => ({
    id: r.id,
    namen: [r.canonical_naam, r.naam, ...String(r.aliassen || '').split(',')].map(x => (x || '').trim()).filter(Boolean),
  }));
  const { data: berRows } = await sb.from('bereiding').select('id, locatie, canonical_bereiding(canonical_naam)');
  const bereidingIndex = (berRows || []).map(b => ({ id: b.id, locatie: b.locatie, namen: [b.canonical_bereiding?.canonical_naam].filter(Boolean) }));

  // Stap 0: auto-negeer niet-ingrediënten (geen hoeveelheid, of naam is een methode-header).
  const NIET_INGREDIENT = /^(deel|stap|fase|onderdeel|methode|bereiding|introductie|afwerking|presentatie|basis|saus|crème)\s*\d*:?\s*$/i;
  const { data: alleReviews } = await sb.from('bereiding_import_review')
    .select('id, bereiding_id, regel_naam, hoeveelheid, eenheid').eq('status', 'pending');
  let nNegeer = 0;
  for (const rv of alleReviews || []) {
    const isHeader = rv.hoeveelheid == null || NIET_INGREDIENT.test((rv.regel_naam || '').trim());
    if (isHeader) {
      nNegeer++;
      console.log(`  ∅ ${rv.regel_naam} → auto-negeer (geen hoeveelheid / methode-header)`);
      if (COMMIT) await sb.from('bereiding_import_review').update({ status: 'genegeerd' }).eq('id', rv.id);
    }
  }
  console.log(`  auto-genegeerd: ${nNegeer}\n`);

  // Pending review-regels mét hoeveelheid (zonder hoeveelheid kan geen component worden).
  const reviews = (alleReviews || []).filter(rv => rv.hoeveelheid != null && !NIET_INGREDIENT.test((rv.regel_naam || '').trim()));

  const berLocatie = {}; for (const b of bereidingIndex) berLocatie[b.id] = b.locatie;
  let nLokaal = 0, nHaiku = 0, nGeleerd = 0, nReview = 0, nCyclus = 0, nTwijfel = 0;

  const indexVoor = (rv) => ({
    ingredients: ingredientIndex,
    bereidingen: bereidingIndex.filter(b => b.locatie === berLocatie[rv.bereiding_id] && b.id !== rv.bereiding_id),
  });

  // Stap 1: lokale match (instant). Niet-gevonden verzamelen voor Haiku.
  const teHaiku = [];
  const beslissing = new Map(); // rv.id -> { m, via }
  for (const rv of reviews || []) {
    const m = matchLokaal(rv.regel_naam, indexVoor(rv));
    if (m) { nLokaal++; beslissing.set(rv.id, { m, via: `lokaal ${(m.score * 100).toFixed(0)}%`, bron: 'lokaal' }); }
    else if (USE_HAIKU) teHaiku.push(rv);
    else { beslissing.set(rv.id, null); }
  }
  console.log(`  lokaal gematcht: ${nLokaal} · naar Haiku: ${teHaiku.length}\n`);

  // Stap 2: Haiku PARALLEL. Concurrency 3: met honderden bereidingen worden de prompts groot;
  // hoger knalt over de Anthropic 500k-input-tokens/min-limiet (calls falen → regels terug naar review).
  const CONC = 3;
  for (let i = 0; i < teHaiku.length; i += CONC) {
    const batch = teHaiku.slice(i, i + CONC);
    await Promise.all(batch.map(async (rv) => {
      const index = indexVoor(rv);
      const hk = await matchRegelViaHaiku(rv.regel_naam, {
        ingredients: index.ingredients.map(c => ({ id: c.id, canonical: c.namen[0] })).filter(c => c.canonical),
        bereidingen: index.bereidingen.map(b => ({ id: b.id, canonical: b.namen[0] })).filter(b => b.canonical),
      }, anthropicKey);
      if (hk && hk.id) { nHaiku++; beslissing.set(rv.id, { m: { id: hk.id, type: hk.type, score: hk.confidence / 100 }, via: `haiku ${hk.confidence}%`, bron: 'haiku' }); }
      else beslissing.set(rv.id, null);
    }));
    console.log(`  Haiku ${Math.min(i + CONC, teHaiku.length)}/${teHaiku.length} verwerkt…`);
  }

  // Stap 3: schrijven (alias + component + status). Snel; Supabase.
  console.log('');
  // Canonieke naam van een match (voor het Passard-voorstel in de composer).
  const naamVan = (type, id) => ((type === 'bereiding' ? bereidingIndex : ingredientIndex).find(x => x.id === id)?.namen || [])[0] || null;
  const wisVoorstel = { voorstel_type: null, voorstel_id: null, voorstel_naam: null, voorstel_score: null };
  for (const rv of reviews || []) {
    const d = beslissing.get(rv.id);
    if (!d) { nReview++; if (COMMIT) await sb.from('bereiding_import_review').update(wisVoorstel).eq('id', rv.id); console.log(`  · ${rv.regel_naam} → blijft review`); continue; }
    const { m, via } = d;
    // Trechtermond: twijfel niet auto-koppelen — wél Passard's suggestie bewaren zodat de composer
    // 'm als één-klik "Bevestig" toont (mens bevestigt de zwakke schakel).
    if (!isZeker(d)) {
      nTwijfel++;
      const vnaam = naamVan(m.type, m.id);
      if (COMMIT) await sb.from('bereiding_import_review').update({ voorstel_type: m.type, voorstel_id: m.id, voorstel_naam: vnaam, voorstel_score: Math.round(m.score * 100) / 100 }).eq('id', rv.id);
      console.log(`  ? ${rv.regel_naam} → twijfel (${via}) — voorstel: ${vnaam || '?'} → bevestig in composer`);
      continue;
    }
    if (m.type === 'ingredient' && m.score < 1 && await leerAlias(m.id, rv.regel_naam, ingredientIndex)) nGeleerd++;
    console.log(`  ✓ ${rv.regel_naam} → ${m.type} (${via})`);
    if (COMMIT) {
      const row = { bereiding_id: rv.bereiding_id, hoeveelheid: rv.hoeveelheid, eenheid: rv.eenheid || 'g' };
      if (m.type === 'bereiding') row.sub_bereiding_id = m.id; else row.ingredient_id = m.id;
      const { error } = await sb.from('bereiding_component').insert(row);
      if (error) { if (/cycl/i.test(error.message)) { nCyclus++; console.log(`    ⚠ cyclus — overgeslagen`); continue; } console.log('    ⚠', error.message); continue; }
      await sb.from('bereiding_import_review').update({ status: 'gekoppeld' }).eq('id', rv.id);
    }
  }

  console.log('\n=== Samenvatting ===');
  console.log(`  review-regels bekeken: ${(reviews || []).length}`);
  console.log(`  gekoppeld lokaal:      ${nLokaal}`);
  console.log(`  gekoppeld via Haiku:   ${nHaiku}`);
  console.log(`  aliassen geleerd:      ${nGeleerd}`);
  console.log(`  cyclus overgeslagen:   ${nCyclus}`);
  console.log(`  twijfel (→ bevestig):  ${nTwijfel}`);
  console.log(`  blijft review:         ${nReview}`);
  console.log(`  drempels: lokaal ≥ ${AUTO_LOKAAL}, haiku ≥ ${AUTO_HAIKU}${KOPPEL_ALLES ? ' (genegeerd: --alles)' : ''}`);
  if (!COMMIT) console.log('\nDraai met --commit om te schrijven (alleen de zekere koppelingen).');
})().catch(e => { console.error('FOUT:', e.message); process.exit(1); });
