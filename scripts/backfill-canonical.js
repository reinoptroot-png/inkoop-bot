'use strict';
// Backfill canonical_naam — vult voor elk bestaand ingredient een schone
// restaurant-canonical in via Claude Haiku. NIET-destructief: merget of
// archiveert niets, zet alleen het "Canonical naam"-veld in Notion (en spiegelt
// naar Supabase). Bestaande, handmatig afwijkende canonicals worden NIET
// overschreven (alleen rijen waar canonical leeg is of gelijk aan de eigen naam).
//
// Gebruik:
//   node scripts/backfill-canonical.js --dry-run   # toon voorstel, schrijf niets
//   node scripts/backfill-canonical.js             # schrijf naar Notion
//
// Idee: na deze backfill heeft het Haiku-koppelingsysteem een schone set
// canonicals om nieuwe scan-producten tegen te matchen. Varianten die dezelfde
// canonical krijgen kun je daarna desgewenst samenvoegen (autoMerge / app).

const path = require('path');
const fs = require('fs');
const fetch = require('node-fetch');
const NotionSync = require('../src/notion-sync');

const settings = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'settings.json'), 'utf8'));
const dryRun = process.argv.includes('--dry-run');

// Vraag Haiku om per ingredient een schone canonical restaurantnaam.
async function canonicalBatch(names, anthropicKey) {
  const prompt = `Je normaliseert ingredient-namen voor een restaurant.

Geef voor elk product een "canonical": de schone restaurantnaam — lowercase
Nederlands, zonder merk, leverancier, verpakking, gewicht, kwaliteitsklasse of
datum. Voorbeelden:
- "Dagverse freiland eieren scharrel 53-63g" → "eieren"
- "Burrata di bufala 125g Lindenhoff" → "burrata"
- "asperges aa ongeschild 2-6" → "asperges"
- "parmigiano reggiano 24 mnd" → "parmezaan"
Behoud betekenisvolle onderscheidingen (bio vs niet-bio NIET samenvoegen; rund
≠ varken; rode ≠ witte wijnazijn).

Retourneer ALLEEN een JSON array: [{"original":"...","canonical":"..."}], geen markdown.

Producten:
${names.map((n, i) => `${i + 1}. ${n}`).join('\n')}`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 2000, messages: [{ role: 'user', content: prompt }] }),
  });
  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  const raw = (data.content?.[0]?.text || '').replace(/```json|```/g, '').trim();
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('verwacht array');
  return parsed;
}

async function run() {
  for (const k of ['notionToken', 'notionDbId', 'anthropicKey']) {
    if (!settings[k]) { console.error(`Ontbrekende setting: ${k}`); process.exit(1); }
  }
  const notion = new NotionSync({ notionToken: settings.notionToken, notionDbId: settings.notionDbId, anthropicKey: settings.anthropicKey });

  const prices = await notion.getAllPrices();
  // Alleen rijen zonder eigen (handmatige) canonical: canonical leeg of == naam.
  const teDoen = prices.filter(p => !p.canonical_naam || p.canonical_naam === p.name);
  console.log(`${prices.length} ingrediënten, ${teDoen.length} zonder eigen canonical${dryRun ? ' (DRY-RUN)' : ''}\n`);
  if (!teDoen.length) { console.log('Niets te doen.'); return; }

  let gezet = 0, ongewijzigd = 0;
  const BATCH = 20;
  for (let i = 0; i < teDoen.length; i += BATCH) {
    const batch = teDoen.slice(i, i + BATCH);
    let res = [];
    try { res = await canonicalBatch(batch.map(b => b.name), settings.anthropicKey); }
    catch (e) { console.warn(`  batch ${i / BATCH + 1} fout: ${e.message} — overgeslagen`); continue; }

    for (const item of batch) {
      const m = res.find(r => (r.original || '').toLowerCase().trim() === item.name.toLowerCase().trim());
      const canonical = (m?.canonical || '').toLowerCase().trim();
      if (!canonical || canonical === item.name) { ongewijzigd++; continue; }
      if (dryRun) {
        console.log(`  "${item.name}"  →  canonical: "${canonical}"`);
      } else {
        try {
          await notion.client.pages.update({
            page_id: item.pageId,
            properties: { 'Canonical naam': { rich_text: [{ text: { content: canonical } }] } },
          });
        } catch (e) { console.warn(`  update fout "${item.name}": ${e.message}`); continue; }
      }
      gezet++;
    }
  }

  console.log(`\n${dryRun ? 'Zou zetten' : 'Gezet'}: ${gezet} canonicals · ongewijzigd: ${ongewijzigd}`);
  if (dryRun) console.log('\nDraai zonder --dry-run om te schrijven. Spiegelen naar Supabase gebeurt automatisch bij de volgende bot-scan (mirrorNaarSupabase).');
}

run().catch(e => { console.error('Fout:', e.message); process.exit(1); });
