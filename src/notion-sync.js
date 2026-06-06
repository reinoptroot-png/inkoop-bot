const { Client } = require('@notionhq/client');
const fetch = require('node-fetch');

// --- Fuzzy match helpers ---
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => Array.from({ length: n + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}

function nameSimilarity(a, b) {
  const na = a.toLowerCase().trim(), nb = b.toLowerCase().trim();
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(na, nb) / maxLen;
}

// Token-Jaccard: beter voor dedup op langere namen met gewicht/verpakking in de naam
function tokenJaccard(a, b) {
  const tokens = s => new Set(s.toLowerCase().trim().split(/[\s,.()\-\/]+/).filter(t => t.length > 1));
  const ta = tokens(a), tb = tokens(b);
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = new Set([...ta, ...tb]).size;
  return union === 0 ? 1 : inter / union;
}

function findFuzzyMatch(naam, existing, threshold = 0.80) {
  let best = null, bestScore = 0;
  for (const e of existing) {
    let score = nameSimilarity(naam, e.name);
    if (score > bestScore) { bestScore = score; best = e; }
    for (const alias of (e.aliassen || [])) {
      score = nameSimilarity(naam, alias);
      if (score > bestScore) { bestScore = score; best = e; }
    }
  }
  return bestScore >= threshold ? { match: best, score: bestScore } : null;
}

// Dedup-check: >90% token-Jaccard + zelfde leverancier + zelfde prijs (±1%)
// Geeft de bestaande match terug als het een duidelijke duplicaat is.
function findDedupMatch(naam, price, leverancier, existing) {
  const THRESHOLD = 0.90;
  let best = null, bestScore = 0;
  for (const e of existing) {
    const score = Math.max(tokenJaccard(naam, e.name), nameSimilarity(naam, e.name));
    if (score < THRESHOLD) continue;

    const levGelijk = (leverancier || '').toLowerCase().trim() === (e.leverancier || '').toLowerCase().trim();
    const prijsGelijk = e.price !== null && price !== null
      && Math.abs(e.price - price) / Math.max(e.price, price, 0.01) < 0.01;

    if (levGelijk && prijsGelijk && score > bestScore) {
      bestScore = score;
      best = e;
    }
  }
  return best ? { match: best, score: bestScore } : null;
}

// --- Claude Haiku classificatie ---
async function classifyBatch(products, anthropicKey) {
  const names = products.map(p => p.ingredient.toLowerCase().trim());
  const prompt = `Je classificeert ingrediënten voor een restaurant inkoopbot.

Geef voor elk product:
- original: exact de ingevoerde naam
- simple_name: korte Nederlandse naam, lowercase (bijv "tomaat", "kippendij", "parmezaan reggiano")
- is_drank: true als het een drank/drankverwant product is (water, wijn, bier, frisdrank, sap, koffie, thee, etc), anders false. UITZONDERING: producten die "azijn" bevatten (wijnazijn, champagne azijn, balsamico azijn, etc.) zijn altijd is_drank: false, categorie: droogwaren.
- categorie: één van: zuivel | vlees | vis | groenten | droogwaren | drank

Retourneer ALLEEN een JSON array, geen markdown, geen uitleg.

Producten:
${names.map((n, i) => `${i + 1}. ${n}`).join('\n')}`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': anthropicKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'prompt-caching-2024-07-31'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  const raw = (data.content?.[0]?.text || '').replace(/```json|```/g, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`classifyBatch: JSON.parse mislukt — ${e.message}. Response: ${raw.substring(0, 200)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`classifyBatch: verwacht array, kreeg ${typeof parsed}`);
  }
  return parsed;
}

class NotionSync {
  constructor(settings) {
    this.client = new Client({ auth: (settings.notionToken || '').trim() });
    this.dbId = (settings.notionDbId || '').trim();
    this.historyDbId = '2d313fcc4d2f480c84ee3344a70cbdcb';
    this.anthropicKey = settings.anthropicKey;
  }

  async getAllPrices() {
    const results = [];
    let cursor;
    do {
      const r = await this.client.databases.query({ database_id: this.dbId, start_cursor: cursor, page_size: 100 });
      for (const page of r.results) {
        const props = page.properties;
        const name = props['Ingredient']?.title?.[0]?.plain_text || '';
        if (!name) continue;
        const aliasRaw = props['Aliassen']?.rich_text?.[0]?.plain_text || '';
        results.push({
          pageId: page.id,
          name: name.toLowerCase().trim(),
          price: props['Kostprijs']?.number ?? null,
          eenheid: props['Eenheid']?.rich_text?.[0]?.plain_text || 'kg',
          leverancier: props['Leverancier']?.rich_text?.[0]?.plain_text || '',
          aliassen: aliasRaw ? aliasRaw.split(',').map(a => a.trim().toLowerCase()).filter(Boolean) : [],
          isDrank: props['Is drank']?.checkbox || false,
          categorie: props['Categorie']?.select?.name || '',
        });
      }
      cursor = r.has_more ? r.next_cursor : undefined;
    } while (cursor);
    return results;
  }

  async updatePriceOnly(pageId, price, leverancier) {
    const today = new Date().toISOString().split('T')[0];
    const props = {
      'Kostprijs': { number: price },
      'Leverancier': { rich_text: [{ text: { content: leverancier || '' } }] },
    };
    // Probeer 'Laatste update' te zetten (veld hoeft niet te bestaan)
    try {
      await this.client.pages.update({ page_id: pageId, properties: { ...props, 'Laatste update': { date: { start: today } } } });
    } catch {
      await this.client.pages.update({ page_id: pageId, properties: props });
    }
  }

  async addAlias(pageId, currentAliassen, newAlias) {
    const all = [...new Set([...currentAliassen, newAlias.toLowerCase().trim()])].join(', ');
    await this.client.pages.update({
      page_id: pageId,
      properties: { 'Aliassen': { rich_text: [{ text: { content: all } }] } }
    });
  }

  async createProduct(item) {
    const naam = (item.ingredient || '').toLowerCase().trim();
    const today = new Date().toISOString().split('T')[0];
    const props = {
      'Ingredient': { title: [{ text: { content: naam } }] },
      'Kostprijs': { number: item.price },
      'Eenheid': { rich_text: [{ text: { content: item.eenheid || 'kg' } }] },
      'Leverancier': { rich_text: [{ text: { content: item.leverancier || '' } }] },
    };
    // Optionele velden — alleen toevoegen als ze beschikbaar zijn in het schema
    try {
      await this.client.pages.create({ parent: { database_id: this.dbId }, properties: {
        ...props,
        'Is drank': { checkbox: item.isDrank || false },
        'Categorie': { select: { name: item.categorie || 'droogwaren' } },
        'Laatste update': { date: { start: today } }
      }});
    } catch {
      // Fallback zonder extra velden als schema ze niet heeft
      await this.client.pages.create({ parent: { database_id: this.dbId }, properties: props });
    }
  }

  async saveHistory(items) {
    const datum = new Date().toISOString().split('T')[0];
    for (const item of items) {
      try {
        await this.client.pages.create({
          parent: { database_id: this.historyDbId },
          properties: {
            'Ingredient': { title: [{ text: { content: (item.ingredient || '').toLowerCase().trim() } }] },
            'Prijs': { number: item.price },
            'Eenheid': { rich_text: [{ text: { content: item.eenheid || 'kg' } }] },
            'Leverancier': { rich_text: [{ text: { content: item.leverancier || '' } }] },
            'Datum': { date: { start: datum } },
            'Source': { rich_text: [{ text: { content: 'imap' } }] }
          }
        });
      } catch { /* history schrijffout overslaan */ }
    }
  }

  async syncAll(items, { dryRun = false } = {}) {
    if (dryRun) console.log('\n⚙️  DRY-RUN — geen schrijfacties naar Notion\n');

    const existing = await this.getAllPrices();

    // Bouw lookup maps
    const nameMap = {};
    for (const e of existing) {
      nameMap[e.name] = e;
      for (const alias of e.aliassen) nameMap[alias] = e;
    }

    const toCreate = [];
    const results = { updated: 0, created: 0, aliasAdded: 0, dryRun };

    for (const item of items) {
      const naam = item.ingredient.toLowerCase().trim();

      // 1. Exacte match (naam of alias)
      const exact = nameMap[naam];
      if (exact) {
        if (dryRun) {
          console.log(`  ✏️  UPDATE  "${naam}"  was €${exact.price ?? '?'} → €${item.price}  (${item.leverancier})`);
        } else {
          await this.updatePriceOnly(exact.pageId, item.price, item.leverancier);
        }
        results.updated++;
        continue;
      }

      // 2. Dedup-check (>90% naam + zelfde leverancier + zelfde prijs → alias, geen nieuw ingredient)
      const dedup = findDedupMatch(naam, item.price, item.leverancier, existing);
      if (dedup) {
        const pct = Math.round(dedup.score * 100);
        if (dryRun) {
          console.log(`  [DEDUP]   "${naam}" → "${dedup.match.name}" (${pct}% match, zelfde lev+prijs) — alias toegevoegd`);
        } else {
          await this.addAlias(dedup.match.pageId, dedup.match.aliassen, naam);
          nameMap[naam] = dedup.match;
          console.log(`  [DEDUP] "${naam}" → alias op "${dedup.match.name}" (${pct}%)`);
        }
        results.aliasAdded++;
        continue;
      }

      // 3. Fuzzy match (>80%) — alias + prijs bijwerken
      const fuzzy = findFuzzyMatch(naam, existing);
      if (fuzzy) {
        const pct = Math.round(fuzzy.score * 100);
        if (dryRun) {
          console.log(`  🔗 ALIAS   "${naam}" → "${fuzzy.match.name}" (${pct}% match) — alias toegevoegd, prijs bijgewerkt`);
        } else {
          await this.addAlias(fuzzy.match.pageId, fuzzy.match.aliassen, naam);
          await this.updatePriceOnly(fuzzy.match.pageId, item.price, item.leverancier);
          nameMap[naam] = fuzzy.match;
        }
        results.aliasAdded++;
        continue;
      }

      // 4. Nieuw product
      toCreate.push(item);
    }

    // Classificeer nieuwe producten in batches van max 20
    if (toCreate.length > 0) {
      if (dryRun) console.log(`\n  🤖 Claude Haiku classificeert ${toCreate.length} nieuwe producten...\n`);
      const BATCH_SIZE = 20;
      for (let i = 0; i < toCreate.length; i += BATCH_SIZE) {
        const batch = toCreate.slice(i, i + BATCH_SIZE);
        let classified = [];
        try {
          classified = await classifyBatch(batch, this.anthropicKey);
          if (dryRun) console.log(`  Batch ${Math.floor(i / BATCH_SIZE) + 1}: ${classified.length} geclassificeerd`);
        } catch (e) {
          console.error(`  ⚠️  Classificatie mislukt: ${e.message}`);
        }

        for (const item of batch) {
          const naam = item.ingredient.toLowerCase().trim();
          const cls = classified.find(c => (c.original || '').toLowerCase().trim() === naam) || {};
          const simpleName = cls.simple_name || naam;
          const isDrank = cls.is_drank || false;
          const categorie = cls.categorie || 'droogwaren';

          if (dryRun) {
            console.log(`  ✨ NIEUW   "${naam}"`);
            console.log(`           → naam: "${simpleName}" | categorie: ${categorie} | is_drank: ${isDrank}`);
            console.log(`           → prijs: €${item.price}/${item.eenheid} via ${item.leverancier}`);
          } else {
            await this.createProduct({ ...item, ingredient: simpleName, isDrank, categorie });
          }
          results.created++;
        }
      }
    }

    if (!dryRun) await this.saveHistory(items);

    return results;
  }
}

module.exports = NotionSync;
