// Receptencomposer — Fase 2: pure helpers voor de import.
//  - normEenheid: receptuur-eenheid -> { factor, basis }  (basis: 'g' | 'ml' | 'stuks')
//  - schatYield:  yield schatten als 'Opbrengst' ontbreekt (som van inputs, GEFLAGD)
//  - matchLokaal: deterministische naam-match (exact + token-Jaccard) tegen canonicals
// Geen I/O — testbaar.

function normEenheid(e) {
  const x = (e || '').toLowerCase().trim();
  if (['g', 'gr', 'gram', 'grammen'].includes(x)) return { factor: 1, basis: 'g' };
  if (['kg', 'kilo', 'kilogram'].includes(x)) return { factor: 1000, basis: 'g' };
  if (['ml', 'milliliter'].includes(x)) return { factor: 1, basis: 'ml' };
  if (['l', 'lt', 'ltr', 'liter', 'liter'].includes(x)) return { factor: 1000, basis: 'ml' };
  if (['st', 'stk', 'stuk', 'stuks', 'x'].includes(x)) return { factor: 1, basis: 'stuks' };
  return null;
}

// Schat de eind-yield uit de inputs als er geen gemeten 'Opbrengst' is.
// Telt per basis (g/ml/stuks) op en kiest de dominante. Altijd GEFLAGD als schatting.
// Retour: { yield, basis, geschat:true } of null als niets normaliseerbaar is.
function schatYield(regels) {
  const som = { g: 0, ml: 0, stuks: 0 };
  let raak = false;
  for (const r of regels) {
    if (r.hoeveelheid == null) continue;
    const n = normEenheid(r.eenheid);
    if (!n) continue;
    som[n.basis] += r.hoeveelheid * n.factor;
    raak = true;
  }
  if (!raak) return null;
  const basis = Object.keys(som).reduce((a, b) => (som[b] > som[a] ? b : a));
  if (som[basis] <= 0) return null;
  return { yield: som[basis], basis, geschat: true };
}

// 'gram' i.p.v. 'g' voor het output_eenheid-veld (check accepteert gram/ml/stuks).
function basisNaarOutputEenheid(basis) {
  return basis === 'g' ? 'gram' : (basis === 'ml' ? 'ml' : 'stuks');
}

function normNaam(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function tokens(s) { return new Set(normNaam(s).split(' ').filter(Boolean)); }
function jaccard(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

// index = { ingredients:[{id, namen:[...]}], bereidingen:[{id, namen:[...]}] }
// Retour: { id, type:'ingredient'|'bereiding', score } of null.
function matchLokaal(naam, index, drempel = 0.6) {
  const doel = normNaam(naam);
  if (!doel) return null;
  // 1) exact op een van de namen/aliassen. Gelijke exacte match: bereiding wint (samengesteld item).
  for (const type of ['bereiding', 'ingredient']) {
    const lijst = type === 'bereiding' ? index.bereidingen : index.ingredients;
    for (const c of (lijst || [])) {
      if ((c.namen || []).some(n => normNaam(n) === doel)) return { id: c.id, type, score: 1 };
    }
  }
  // 2) beste token-Jaccard over alles
  let best = null;
  for (const type of ['ingredient', 'bereiding']) {
    const lijst = type === 'ingredient' ? index.ingredients : index.bereidingen;
    for (const c of (lijst || [])) {
      for (const n of (c.namen || [])) {
        const s = jaccard(naam, n);
        if (s > (best?.score || 0)) best = { id: c.id, type, score: s };
      }
    }
  }
  return best && best.score >= drempel ? best : null;
}

module.exports = { normEenheid, schatYield, basisNaarOutputEenheid, matchLokaal, normNaam, jaccard };
