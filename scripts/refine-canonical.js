'use strict';
// Verfijn canonical_naam voor clusters die te grof gegroepeerd zijn.
//
// De eerste backfill (scripts/backfill-canonical.js) bekeek elk product los en
// groepeerde soms te agressief: "oesters irish mor nr 3" en "oesters zeeuwse nr 0"
// kregen allebei canonical "oesters" — terwijl het verschillende producten zijn
// met verschillende prijzen. Dit script herbekijkt elke multi-member cluster MET
// de zustervarianten als context, zodat Haiku echt verschillende producten
// (variëteit / herkomst / kwaliteitsklasse / type) een eigen, specifiekere
// canonical geeft, maar pure verpakkings-/maat-/merkvarianten samen houdt.
//
// Niet-destructief: zet alleen het Notion "Canonical naam"-veld. Merget/archiveert
// niets. --dry-run toont het voorstel zonder te schrijven.
//
// Gebruik:
//   node scripts/refine-canonical.js --dry-run
//   node scripts/refine-canonical.js

const path = require('path');
const fs = require('fs');
const fetch = require('node-fetch');
const NotionSync = require('../src/notion-sync');

const settings = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'settings.json'), 'utf8'));
const dryRun = process.argv.includes('--dry-run');

// Vraag Haiku om binnen één cluster elke variant een passende canonical te geven.
async function verfijnCluster(leden, anthropicKey) {
  const lijst = leden.map((m, i) =>
    `${i + 1}. "${m.name}"${m.kostprijs != null ? ` — €${m.kostprijs}/${m.eenheid || '?'}` : ''}${m.leverancier ? ` (${m.leverancier})` : ''}`
  ).join('\n');

  const prompt = `Deze producten kregen voorlopig dezelfde canonical, maar dat is mogelijk te grof.

Producten:
${lijst}

Bepaal per product de juiste "canonical" = schone restaurantnaam (lowercase
Nederlands, zonder merk/leverancier/verpakking/gewicht/datum). REGELS:
- Echt verschillende producten krijgen een EIGEN, specifiekere canonical. Splits
  op betekenisvolle verschillen: variëteit, herkomst, kwaliteitsklasse, type,
  bewerking, en grote prijsverschillen (>25%). Voorbeelden:
  · "oesters irish mor nr 3" → "oesters irish", "oesters zeeuwse nr 0" → "oesters zeeuws"
  · "olijfolie tarragona" → "olijfolie tarragona", "olijfolie sicilië" → "olijfolie sicilië"
  · "krul peterselie" → "krulpeterselie", "platte peterselie" → "platte peterselie"
  · "garnalen gekraakt" → "garnalen gekraakt", "gepelde garnalen" → "gepelde garnalen"
- Pure verpakkings-/maat-/merkvarianten van HETZELFDE product krijgen DEZELFDE
  canonical: "basilicum 35 gram" en "basilicum groen" → beide "basilicum".
- Bio nooit samen met niet-bio.

Retourneer ALLEEN een JSON array: [{"original":"...","canonical":"..."}], geen markdown.`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1500, messages: [{ role: 'user', content: prompt }] }),
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
  // Supabase-kostprijs/eenheid nemen we mee als hint; getAllPrices heeft price+eenheid.
  prices.forEach(p => { p.kostprijs = p.price; });

  // Groepeer op huidige canonical; alleen clusters met >1 lid herbekijken.
  const groups = {};
  for (const p of prices) { const c = p.canonical_naam || p.name; (groups[c] = groups[c] || []).push(p); }
  const clusters = Object.entries(groups).filter(([, m]) => m.length > 1);
  console.log(`${clusters.length} multi-member clusters${dryRun ? ' (DRY-RUN)' : ''}\n`);

  let gewijzigd = 0, gesplitst = 0;
  for (const [canonical, leden] of clusters) {
    let res = [];
    try { res = await verfijnCluster(leden, settings.anthropicKey); }
    catch (e) { console.warn(`  cluster "${canonical}" fout: ${e.message} — overgeslagen`); continue; }

    const nieuweCanonicals = new Set();
    const updates = [];
    for (const lid of leden) {
      const m = res.find(r => (r.original || '').toLowerCase().trim() === lid.name.toLowerCase().trim());
      const nieuw = (m?.canonical || '').toLowerCase().trim();
      if (!nieuw) continue;
      nieuweCanonicals.add(nieuw);
      if (nieuw !== (lid.canonical_naam || lid.name)) updates.push({ lid, nieuw });
    }
    if (nieuweCanonicals.size > 1) gesplitst++;
    if (!updates.length) continue;

    console.log(`■ ${canonical} (${leden.length}) → ${nieuweCanonicals.size} canonical(s)`);
    for (const { lid, nieuw } of updates) {
      console.log(`    "${lid.name}"  →  "${nieuw}"`);
      if (!dryRun) {
        try {
          await notion.client.pages.update({ page_id: lid.pageId, properties: { 'Canonical naam': { rich_text: [{ text: { content: nieuw } }] } } });
        } catch (e) { console.warn(`    update fout: ${e.message}`); continue; }
      }
      gewijzigd++;
    }
  }

  console.log(`\n${dryRun ? 'Zou wijzigen' : 'Gewijzigd'}: ${gewijzigd} canonicals · ${gesplitst} clusters opgesplitst`);
  if (dryRun) console.log('Draai zonder --dry-run om te schrijven. Spiegelen naar Supabase gebeurt bij de volgende bot-scan.');
}

run().catch(e => { console.error('Fout:', e.message); process.exit(1); });
