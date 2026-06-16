// Euro Food Monitor — classificeer bereidingen als RECEPTUUR vs METHODE (Passard).
//
// In de Notion-bron staan kok-recepten door elkaar: échte recepturen (mayonaise, sauzen, jus,
// olie…) die een kostprijs hebben en interessant zijn voor de calculatie, én methodes ("hoe gaar
// je asperges", "pekelen", "snijden") die alleen instructie zijn. Voor de calculatie willen we
// alleen recepturen. Dit zet methodes op status='methode' (telt niet mee, geen "prijs onbekend"-ruis).
//
// Heuristiek (conservatief — we verbergen NOOIT een bereiding die een kostprijs heeft):
//   1) naam bevat een receptuur-zelfstandignaamwoord (saus/mayo/jus/olie/…) → RECEPTUUR
//   2) anders: techniek-werkwoord (garen/bakken/snijden/pekelen/…) ÉN géén kostprijs → METHODE
//      (heeft het wél een prijs, dan is het een gekoste component → laten staan, niet verbergen)
//   3) anders: ONBESLIST → laten staan (actief)
//
//   node classify-bereidingen.js          # DRY-RUN heuristiek (toont de voorgestelde methodes)
//   node classify-bereidingen.js --llm    # + Haiku classificeert de ONBESLIST rest (receptuur/methode + confidence)
//   node classify-bereidingen.js --sql    # print UPDATE-SQL voor de Supabase SQL-editor (combineer met --llm)
//
// De LLM-pass is conservatief: een methode-voorstel telt alleen als Haiku 'methode' zegt,
// confidence >= MIN_METHODE_CONFIDENCE, én de bereiding géén kostprijs heeft. Receptuur blijft
// gewoon actief (telt mee). Zo verbergen we nooit een gekoste component op een onzeker LLM-oordeel.

let s = {}; try { s = require('./settings.json'); } catch (e) {}
require('dotenv').config();
const SQL = process.argv.includes('--sql');
const LLM = process.argv.includes('--llm');
const anthropicKey = s.anthropicKey || process.env.ANTHROPIC_KEY || process.env.ANTHROPIC_API_KEY;
const HAIKU = 'claude-haiku-4-5-20251001';
const CONCURRENCY = 3;            // Haiku ~3 req/s + token-rate-limit (zie CHANGELOG 594-import)
const BATCH = 18;                 // namen per Haiku-call (bespaart calls/tokens)
const MIN_METHODE_CONFIDENCE = 70; // alleen verbergen als Haiku zeker genoeg is
const sb = require('@supabase/supabase-js').createClient(
  process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY);

const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ' ').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

// Receptuur = een ding dat je máákt (heeft een kostprijs). Zelfstandige naamwoorden.
const RECEPTUUR = ['saus', 'saus', 'mayo', 'mayonaise', 'dressing', 'vinaigrette', 'bechamel', 'bechamelle',
  'jus', 'fond', 'bouillon', 'olie', 'compote', 'sorbet', 'ijs', 'beslag', 'veloute', 'veloute',
  'hollandaise', 'bearnaise', 'aioli', 'pesto', 'tapenade', 'gel', 'espuma', 'creme', 'room',
  'sap', 'pekel', 'marinade', 'coulis', 'gastrique', 'ganache', 'puree', 'mousse', 'emulsie',
  'dashi', 'miso', 'chutney', 'relish', 'salsa', 'dip', 'spread', 'boter', 'mayo', 'kruidenolie',
  'siroop', 'gel', 'jam', 'confituur', 'praline', 'ketchup', 'crumble', 'crème'];
// Methode = een handeling/techniek (werkwoorden + voltooid deelwoorden).
// Bewust WEGGELATEN: aanmaken/aangemaakt (= aanmengen) en opslaan/opgeslagen (= opkloppen) —
// die leveren juist een gekoste component op.
const METHODE = ['garen', 'gegaard', 'koken', 'gekookt', 'bakken', 'gebakken', 'braden', 'gebraden',
  'grillen', 'gegrild', 'frituren', 'gefrituurd', 'pekelen', 'gepekeld', 'blancheren', 'geblancheerd',
  'snijden', 'gesneden', 'hakken', 'gehakt', 'raspen', 'geraspt', 'plukken', 'geplukt', 'portioneren',
  'afwegen', 'wegen', 'roosteren', 'geroosterd', 'ontvliezen', 'schillen', 'geschild', 'wellen',
  'weken', 'geweekt', 'drogen', 'gedroogd', 'temperen', 'zeven', 'wassen', 'gewassen'];

// heeftPrijs: heeft deze bereiding een berekende prijs (= gekoste component)?
function classify(naam, heeftPrijs) {
  const toks = new Set(norm(naam).split(' ').filter(Boolean));
  const recept = RECEPTUUR.find(w => toks.has(w));
  if (recept) return { soort: 'receptuur', reden: `bevat "${recept}"` };
  const meth = METHODE.find(w => toks.has(w));
  if (meth && !heeftPrijs) return { soort: 'methode', reden: `techniek "${meth}", geen kostprijs` };
  if (meth && heeftPrijs) return { soort: 'receptuur', reden: `techniek "${meth}" maar wél een kostprijs → gekoste component` };
  return { soort: 'onbeslist', reden: 'geen duidelijk signaal' };
}

// Draai taken met een vaste concurrency (zelfde patroon als seed-concept-kennis.js).
async function pool(items, n, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const idx = i++; try { out[idx] = await fn(items[idx], idx); } catch (e) { out[idx] = { error: e.message }; } }
  }));
  return out;
}

// Vraag Haiku een batch onbeslist-bereidingen te classificeren als receptuur vs methode.
// items: [{ id, naam, heeftPrijs }]. Antwoord per item: { id, soort, confidence, reden }.
async function vraagHaiku(items) {
  const lijst = items.map((b, i) => `${i + 1}. "${b.naam}"${b.heeftPrijs ? ' (heeft al een berekende kostprijs)' : ''}`).join('\n');
  const prompt = `Je bent een professionele kok. Hieronder staan namen van keuken-"bereidingen" uit een receptendatabase. Classificeer elke als:
- "receptuur": iets dat je MÁÁKT en dat een kostprijs heeft of kan hebben (een saus, jus, olie, marinade, beslag, puree, mengsel, component die je samenstelt uit ingrediënten).
- "methode": een pure techniek/handeling/instructie ZONDER eigen kostprijs (bv. "asperges garen", "ui snijden", "pekelen", "blancheren", "portioneren").

${lijst}

Antwoord ALLEEN met JSON (geen markdown), een array in dezelfde volgorde:
[{"nr":<regelnummer>,"soort":"receptuur"|"methode","confidence":<0-100>,"reden":"<1 korte zin>"}]
Regels:
- confidence 0-100 = hoe zeker je bent; laag (<40) bij twijfel.
- Een ding dat al een kostprijs heeft is vrijwel altijd receptuur (een gekoste component), geen methode.
- Laat geen regel weg.`;

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: HAIKU, max_tokens: 1500, messages: [{ role: 'user', content: prompt }] }),
  });
  const data = await resp.json();
  if (data.error) throw new Error(data.error.message);
  const raw = (data.content?.[0]?.text || '').replace(/```json|```/g, '').trim();
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('verwacht JSON array');
  return parsed.map(r => {
    const item = items[Number(r.nr) - 1];
    if (!item) return null;
    const soort = String(r.soort || '').toLowerCase() === 'methode' ? 'methode' : 'receptuur';
    return { id: item.id, naam: item.naam, heeftPrijs: item.heeftPrijs, soort, confidence: Number(r.confidence), reden: String(r.reden || '').slice(0, 200) };
  }).filter(Boolean);
}

(async () => {
  if (!SQL) console.log(LLM ? '=== DRY-RUN + Haiku-pass — geen writes ===\n' : '=== DRY-RUN heuristiek — geen writes ===\n');
  if (LLM && !anthropicKey) { console.error('Geen ANTHROPIC_KEY/anthropicKey gevonden — kan de LLM-pass niet draaien.'); process.exit(1); }

  const { data: ber } = await sb.from('bereiding').select('id, status, canonical_bereiding(canonical_naam), bereiding_kostprijs(prijs_per_eenheid)');
  const rijen = (ber || []).map(b => ({ id: b.id, naam: b.canonical_bereiding?.canonical_naam || '', status: b.status, heeftPrijs: b.bereiding_kostprijs?.prijs_per_eenheid != null }));

  const telling = { receptuur: 0, methode: 0, onbeslist: 0 };
  const nieuweMethodes = [];   // nu actief, voorgesteld → methode (heuristiek)
  const onbeslist = [];        // door heuristiek niet beslist → kandidaat voor de LLM-pass
  for (const r of rijen) {
    const c = classify(r.naam, r.heeftPrijs);
    telling[c.soort]++;
    if (c.soort === 'methode' && r.status !== 'methode') nieuweMethodes.push({ ...r, reden: c.reden });
    else if (c.soort === 'onbeslist' && r.status !== 'methode') onbeslist.push(r);
  }

  // LLM-pass: Haiku classificeert de onbeslist-rest (receptuur/methode + confidence).
  const llmMethodes = [];      // door Haiku zeker genoeg → methode
  let llmReceptuur = 0, llmTwijfel = 0, llmMislukt = 0;
  if (LLM && onbeslist.length) {
    const batches = [];
    for (let i = 0; i < onbeslist.length; i += BATCH) batches.push(onbeslist.slice(i, i + BATCH));
    if (!SQL) console.log(`Haiku classificeert ${onbeslist.length} onbeslist bereidingen (${batches.length} batches)…\n`);
    const resultaten = await pool(batches, CONCURRENCY, vraagHaiku);
    for (const r of resultaten) {
      if (!r || r.error) { llmMislukt++; if (!SQL) console.warn('  ! Haiku-fout:', r?.error); continue; }
      for (const c of r) {
        if (c.soort === 'methode' && !c.heeftPrijs && c.confidence >= MIN_METHODE_CONFIDENCE) {
          llmMethodes.push({ id: c.id, naam: c.naam, reden: `Haiku: ${c.reden} [conf ${c.confidence}]` });
        } else if (c.soort === 'methode') {
          llmTwijfel++;  // methode maar te onzeker of heeft prijs → blijft actief
        } else {
          llmReceptuur++;
        }
      }
    }
  }

  const alleMethodes = [...nieuweMethodes, ...llmMethodes];

  if (SQL) {
    if (!alleMethodes.length) { console.log('-- geen nieuwe methodes voorgesteld'); return; }
    console.log('-- Passard: zet voorgestelde methodes op status=methode (tellen niet mee in de calculatie)');
    console.log("update public.bereiding set status='methode', updated_at=now()");
    console.log(' where id in (' + alleMethodes.map(m => `'${m.id}'`).join(', ') + ');');
    return;
  }

  console.log(`Totaal: ${rijen.length} bereidingen`);
  console.log(`  receptuur (telt mee): ${telling.receptuur}`);
  console.log(`  methode (telt NIET mee): ${telling.methode}  (waarvan ${nieuweMethodes.length} nu nog actief → voorstel)`);
  console.log(`  onbeslist (heuristiek): ${telling.onbeslist}\n`);
  console.log('Voorgestelde methodes — heuristiek (nu actief → methode):');
  nieuweMethodes.slice(0, 40).forEach(m => console.log(`  • ${m.naam}  (${m.reden})`));
  if (nieuweMethodes.length > 40) console.log(`  … en ${nieuweMethodes.length - 40} meer`);

  if (LLM) {
    console.log(`\nHaiku-pass op ${onbeslist.length} onbeslist:`);
    console.log(`  → receptuur (blijft actief): ${llmReceptuur}`);
    console.log(`  → methode maar onzeker (<${MIN_METHODE_CONFIDENCE}) of heeft prijs (blijft actief): ${llmTwijfel}`);
    console.log(`  → methode, zeker genoeg → voorstel: ${llmMethodes.length}` + (llmMislukt ? `   (${llmMislukt} batch(es) mislukt)` : ''));
    llmMethodes.slice(0, 40).forEach(m => console.log(`  • ${m.naam}  (${m.reden})`));
    if (llmMethodes.length > 40) console.log(`  … en ${llmMethodes.length - 40} meer`);
  } else {
    console.log('\nDraai met --llm om Haiku de onbeslist-rest te laten classificeren.');
  }
  console.log(`\nTotaal voorgestelde methodes: ${alleMethodes.length}. Draai met --sql voor de UPDATE-SQL.`);
})();
