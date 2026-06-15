// Receptencomposer — Fase 2: Haiku-matcher voor recept-regels.
//
// Matcht één recept-regel tegen ZOWEL de canonical ingrediënten ALS de canonical
// bereidingen, in ÉÉN Haiku-call. Door beide lijsten in één prompt aan te bieden
// disambigueert Haiku zelf met volledige context — geen fragiele tie-break tussen
// twee losse calls (zie review). Hergebruikt het patroon van matchCanonicalViaHaiku
// in notion-sync.js (zelfde model, zelfde fetch-stijl, zelfde JSON-discipline).
//
// Retour: { type:'ingredient'|'bereiding', id, canonical, confidence, uitleg } of null.

const HAIKU = 'claude-haiku-4-5-20251001';

// Pure functie: parse het Haiku-antwoord en map de canonical terug naar id + type.
// Testbaar zonder API. ingredients/bereidingen = [{ canonical, id }].
function parseMatchResponse(raw, ingredients, bereidingen) {
  let parsed;
  try { parsed = JSON.parse((raw || '').replace(/```json|```/g, '').trim()); }
  catch { return null; }
  if (!parsed || typeof parsed.confidence !== 'number') return null;
  if (!parsed.canonical || !parsed.type || parsed.confidence < 30) return null;
  if (parsed.type !== 'ingredient' && parsed.type !== 'bereiding') return null;
  const naam = String(parsed.canonical).toLowerCase().trim();
  const set = parsed.type === 'bereiding' ? bereidingen : ingredients;
  const entry = (set || []).find(x => (x.canonical || '').toLowerCase().trim() === naam);
  if (!entry) return null;  // Haiku verzon een naam die niet in de lijst staat
  return { type: parsed.type, id: entry.id, canonical: naam, confidence: parsed.confidence, uitleg: parsed.uitleg || '' };
}

function buildPrompt(line, ingredients, bereidingen) {
  const il = (ingredients || []).map((c, i) => `I${i + 1}. ${c.canonical}`).join('\n');
  const bl = (bereidingen || []).map((c, i) => `B${i + 1}. ${c.canonical}`).join('\n');
  return `Je koppelt een receptregel aan één bestaand restaurant-item.

Receptregel: ${line}

Bestaande INGREDIËNTEN (rauwe inkoop):
${il || '(geen)'}

Bestaande BEREIDINGEN (zelfgemaakte sauzen/bases/bouillons/deeg):
${bl || '(geen)'}

Een regel is óf een ingrediënt ("100 g boter") óf een bereiding ("200 g tomatensaus",
"gepofte paprika"). Kies het ene best passende item. Geef ALLEEN dit JSON-object:
{
  "type": "ingredient" | "bereiding" | null,
  "canonical": "<exacte naam uit de juiste lijst, of null>",
  "confidence": <0-100>,
  "uitleg": "<één zin>"
}
Regels:
- Kies "bereiding" als de regel naar een samengesteld/zelfgemaakt item verwijst.
- Kies "ingredient" voor een rauw inkoopproduct.
- Bij twijfel of confidence <70: zet type en canonical op null.
- Match nooit duidelijk verschillende producten (rund ≠ varken, mozzarella ≠ burrata).`;
}

async function matchRegelViaHaiku(line, { ingredients = [], bereidingen = [] } = {}, anthropicKey) {
  if (!anthropicKey || (!ingredients.length && !bereidingen.length)) return null;
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: HAIKU,
        max_tokens: 300,
        messages: [{ role: 'user', content: buildPrompt(line, ingredients, bereidingen) }],
      }),
    });
    const data = await resp.json();
    if (data.error) throw new Error(data.error.message);
    return parseMatchResponse(data.content?.[0]?.text || '', ingredients, bereidingen);
  } catch (e) {
    console.warn('[bereiding-match] Haiku fout:', e.message);
    return null;
  }
}

module.exports = { matchRegelViaHaiku, parseMatchResponse, buildPrompt, HAIKU };
