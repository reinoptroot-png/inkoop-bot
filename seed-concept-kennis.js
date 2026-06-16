// Euro Food Monitor — Fase B: seed concept_eenheid_kennis met wereldkennis (Haiku).
//
// Voor elke (concept × tel-eenheid) die in recepten (bereiding_component) gebruikt wordt
// maar nog GEEN gram-kennis heeft, vraagt Haiku het typische gewicht per eenheid met een
// confidence. Geschreven met bron='llm' — de mens bevestigt later in de composer (→ 'mens',
// hoogste trust). Zo wordt het "brein" gebootstrapt met kok-kennis i.p.v. leeg te starten.
//
//   node seed-concept-kennis.js            # DRY-RUN (toont voorstellen, geen writes)
//   node seed-concept-kennis.js --commit   # schrijft de voorstellen (bron='llm')
//
// Idempotent: bestaande (concept, eenheid) in de kennis-tabel wordt overgeslagen, dus een
// mens-bevestigde of eerder geseede waarde wordt nooit overschreven.

let s = {}; try { s = require('./settings.json'); } catch (e) {}
require('dotenv').config();

const COMMIT = process.argv.includes('--commit');
const anthropicKey = s.anthropicKey || process.env.ANTHROPIC_KEY || process.env.ANTHROPIC_API_KEY;
const HAIKU = 'claude-haiku-4-5-20251001';
const CONCURRENCY = 3;   // Haiku ~3 req/s + token-rate-limit (zie CHANGELOG 594-import)
const sb = require('@supabase/supabase-js').createClient(
  process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY);

// Tel-eenheden die een gram-per-eenheid nodig hebben (gelijk aan lib/bereiding-compute.TEL_EENHEDEN).
// Vaste keuken-eenheden (el/tl/snuf/...) hebben al een ingredient-onafhankelijke factor → niet seeden.
const TEL_EENHEDEN = new Set(['bos','bossen','bosje','bosjes','bol','bollen','blad','blaadje','blaadjes',
  'bladeren','tak','takje','takjes','takken','teen','tenen','stengel','stengels','vel','vellen','peul','peulen']);
const norm = (e) => (e || '').toLowerCase().trim();

async function vraagHaiku(concept, eenheden) {
  const cat = concept.categorie ? ` (categorie: ${concept.categorie})` : '';
  const lijst = eenheden.map(e => `- ${e}`).join('\n');
  const prompt = `Je bent een professionele kok. Ik heb het typische gewicht nodig van keuken-eenheden voor het ingrediënt "${concept.canonical_naam}"${cat}.

Geef voor ELK van deze eenheden het gewicht in gram van 1 zo'n eenheid, zoals normaal in een professionele keuken:
${lijst}

Antwoord ALLEEN met JSON (geen markdown), een array:
[{"eenheid":"<eenheid>","gram":<getal>,"confidence":<0-100>,"toelichting":"<1 korte zin>"}]
Regels:
- gram = gewicht in gram van 1 eenheid van DIT ingrediënt (eetbaar deel zoals in een recept gebruikt).
- confidence 0-100 = hoe zeker je bent voor DIT ingrediënt; laag (<30) als de eenheid niet logisch is bij dit product of het gewicht sterk varieert.
- Laat geen eenheid weg.`;

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: HAIKU, max_tokens: 800, messages: [{ role: 'user', content: prompt }] }),
  });
  const data = await resp.json();
  if (data.error) throw new Error(data.error.message);
  const raw = (data.content?.[0]?.text || '').replace(/```json|```/g, '').trim();
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('verwacht JSON array');
  return parsed
    .map(r => ({ eenheid: norm(r.eenheid), gram: Number(r.gram), confidence: Number(r.confidence), toelichting: String(r.toelichting || '').slice(0, 200) }))
    .filter(r => r.eenheid && r.gram > 0 && eenheden.includes(r.eenheid));
}

// Draai taken met een vaste concurrency.
async function pool(items, n, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const idx = i++; try { out[idx] = await fn(items[idx], idx); } catch (e) { out[idx] = { error: e.message }; } }
  }));
  return out;
}

(async () => {
  console.log(COMMIT ? '=== COMMIT — schrijft (bron=llm) ===\n' : '=== DRY-RUN — geen writes ===\n');
  if (!anthropicKey) { console.error('Geen ANTHROPIC_KEY/anthropicKey gevonden.'); process.exit(1); }

  // 1) Data laden.
  const [{ data: prijzen }, { data: comps }, { data: bestaand }] = await Promise.all([
    sb.from('inkoop_prijzen').select('id, naam, concept_id'),
    sb.from('bereiding_component').select('ingredient_id, eenheid').not('ingredient_id', 'is', null),
    sb.from('concept_eenheid_kennis').select('concept_id, eenheid'),
  ]);
  const { data: concepts } = await sb.from('ingredient_concept').select('id, canonical_naam, categorie');
  const conceptById = Object.fromEntries((concepts || []).map(c => [c.id, c]));
  const conceptVanIngredient = Object.fromEntries((prijzen || []).map(p => [p.id, p.concept_id]));
  const bekend = new Set((bestaand || []).map(k => `${k.concept_id}|${norm(k.eenheid)}`));

  // 2) Doelparen (concept × tel-eenheid) uit recepten, nog zonder kennis.
  const doelen = {};  // concept_id -> Set(eenheid)
  for (const c of comps || []) {
    const e = norm(c.eenheid);
    if (!TEL_EENHEDEN.has(e)) continue;
    const cid = conceptVanIngredient[c.ingredient_id];
    if (!cid || bekend.has(`${cid}|${e}`)) continue;
    (doelen[cid] ||= new Set()).add(e);
  }
  const taken = Object.entries(doelen)
    .filter(([cid]) => conceptById[cid])
    .map(([cid, set]) => ({ concept: conceptById[cid], eenheden: [...set] }));

  console.log(`Doelconcepten: ${taken.length} (totaal ${taken.reduce((a, t) => a + t.eenheden.length, 0)} concept×eenheid-paren)\n`);
  if (!taken.length) { console.log('Niets te seeden — alle gebruikte tel-eenheden hebben al kennis.'); return; }

  // 3) Haiku bevragen (concurrency-gelimiteerd).
  let geschreven = 0, mislukt = 0;
  const resultaten = await pool(taken, CONCURRENCY, async (t) => {
    const voorstellen = await vraagHaiku(t.concept, t.eenheden);
    return { concept: t.concept, voorstellen };
  });

  for (const r of resultaten) {
    if (!r || r.error) { mislukt++; console.warn('  ! fout:', r?.error); continue; }
    for (const v of r.voorstellen) {
      const vlag = v.confidence < 30 ? ' (lage confidence)' : '';
      console.log(`  ${r.concept.canonical_naam} · 1 ${v.eenheid} ≈ ${v.gram} g  [conf ${v.confidence}]${vlag} — ${v.toelichting}`);
      if (COMMIT) {
        const { error } = await sb.from('concept_eenheid_kennis').upsert({
          concept_id: r.concept.id, eenheid: v.eenheid, gram_per_eenheid: v.gram,
          confidence: v.confidence, bron: 'llm', toelichting: v.toelichting,
        }, { onConflict: 'concept_id,eenheid', ignoreDuplicates: true });
        if (error) { mislukt++; console.warn('    ! upsert fout:', error.message); } else geschreven++;
      }
    }
  }
  console.log(`\nKlaar. ${COMMIT ? `${geschreven} geschreven, ` : ''}${mislukt} mislukt.`);
  if (!COMMIT) console.log('Draai met --commit om te schrijven.');
})();
