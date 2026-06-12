/**
 * Headless runner — geen Electron nodig.
 * Leest config uit .env of omgevingsvariabelen.
 * Gebruik: node src/headless.js
 *          node src/headless.js --rescan   (ook al gelezen emails, afgelopen 7 dagen)
 */
require('dotenv').config();

const ImapScanner = require('./imap-scanner');
const NotionSync  = require('./notion-sync');

// Supabase meldingen schrijven (optioneel — werkt ook zonder SUPABASE_URL)
let supabase = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
  try {
    const { createClient } = require('@supabase/supabase-js');
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
    console.log('[melding] Supabase meldingen ingeschakeld → scan_meldingen');
  } catch (e) {
    console.warn('[melding] Supabase init mislukt:', e.message);
  }
} else {
  // Veelvoorkomende oorzaak: SUPABASE_URL / SUPABASE_ANON_KEY ontbreken in .env.
  // Zonder deze worden scan-meldingen NIET naar de webapp geschreven.
  console.warn('[melding] ⚠ SUPABASE_URL/SUPABASE_ANON_KEY ontbreken — meldingen worden NIET naar de webapp geschreven. Zie .env.example.');
}

// Idempotente meldingen: voorkom dat dezelfde melding bij elke scan opnieuw
// instroomt (de "loop"). Eénmalige types (nieuw_product/koppeling/mogelijk_dubbel/
// nieuwe_leverancier) worden gededupliceerd op type+naam(+scan_naam); prijs-types
// op type+naam+nieuwe prijs (zelfde prijswijziging niet telkens opnieuw melden).
async function bestaatAlMelding(data) {
  if (!supabase) return false;
  try {
    let q = supabase.from('scan_meldingen').select('id').eq('type', data.type).limit(1);
    if (data.ingredient_naam != null) q = q.eq('ingredient_naam', data.ingredient_naam);
    if (data.type === 'mogelijk_dubbel') {
      if (data.scan_naam != null) q = q.eq('scan_naam', data.scan_naam);
    } else if (data.type === 'prijs_groot' || data.type === 'prijs_klein') {
      if (data.prijs_nieuw != null) q = q.eq('prijs_nieuw', data.prijs_nieuw);
    }
    const { data: rows } = await q;
    return (rows || []).length > 0;
  } catch { return false; }
}

async function schrijfMelding(data) {
  if (!supabase) return;
  try {
    if (await bestaatAlMelding(data)) return; // al gemeld → niet opnieuw (anti-loop)
    const { error } = await supabase.from('scan_meldingen').insert(data);
    if (error) console.warn(`[melding] Supabase schrijffout ("${data.ingredient_naam}"):`, error.message);
  } catch (e) {
    console.warn('[melding] Supabase schrijffout:', e.message);
  }
}

const settings = {
  imapHost:       process.env.IMAP_HOST       || 'imap.one.com',
  imapPort:       process.env.IMAP_PORT       || '993',
  imapUser:       process.env.IMAP_USER,
  imapPass:       process.env.IMAP_PASS,
  imapUser2:      process.env.IMAP_USER2,
  imapPass2:      process.env.IMAP_PASS2,
  imapUser3:      process.env.IMAP_USER3,   // rein@europa.rest — Lightspeed dagrapporten
  imapPass3:      process.env.IMAP_PASS3,
  notionToken:    process.env.NOTION_TOKEN,
  notionDbId:     process.env.NOTION_DB_ID,
  anthropicKey:   process.env.ANTHROPIC_KEY,
  alertThreshold: parseInt(process.env.ALERT_THRESHOLD || '10', 10),
};

const rescan = process.argv.includes('--rescan');
const debug  = process.argv.includes('--all');
const scanOpts = rescan
  ? { reprocess: true, lookbackDays: 7, markSeen: false, debug }
  : { debug };

async function run() {
  const missing = ['imapUser', 'imapPass', 'notionToken', 'notionDbId', 'anthropicKey']
    .filter(k => !settings[k]);
  if (missing.length) {
    console.error('Ontbrekende omgevingsvariabelen:', missing.join(', '));
    process.exit(1);
  }

  console.log(`[inkoop-bot] Scan gestart — ${new Date().toISOString()}${rescan ? ' (--rescan: ook gelezen emails)' : ''}`);

  const scanners = [];
  if (settings.imapUser && settings.imapPass)
    scanners.push(new ImapScanner({ ...settings }));
  if (settings.imapUser2 && settings.imapPass2)
    scanners.push(new ImapScanner({ ...settings, imapUser: settings.imapUser2, imapPass: settings.imapPass2 }));
  if (settings.imapUser3 && settings.imapPass3)
    scanners.push(new ImapScanner({ ...settings, imapUser: settings.imapUser3, imapPass: settings.imapPass3 }));

  const results = (await Promise.all(scanners.map(s => s.scan(scanOpts)))).flat();
  console.log(`[inkoop-bot] ${results.length} items gescand`);

  // Tijdstip van deze scan vastleggen — óók als er geen nieuwe emails zijn —
  // zodat het Dashboard "Laatste scan" altijd het werkelijke scanmoment toont.
  if (supabase) {
    const nu = new Date().toISOString();
    const { error } = await supabase.from('instellingen').upsert(
      { restaurant: 'europizza', key: 'laatste_scan', value: nu, updated_at: nu },
      { onConflict: 'restaurant,key' });
    if (error) console.warn('[scan] laatste_scan niet opgeslagen:', error.message);
    else console.log(`[inkoop-bot] laatste_scan vastgelegd: ${nu}`);
  }

  // Nieuwe food-leverancier kandidaten → 'nieuwe_leverancier' meldingen
  const kandidaten = scanners.flatMap(s => s.nieuweLeveranciers || []);
  if (kandidaten.length) {
    const n = await ImapScanner.schrijfNieuweLeverancierMeldingen(
      process.env.SUPABASE_URL, process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY, kandidaten);
    if (n) console.log(`[inkoop-bot] ${n} nieuwe leverancier-melding(en) aangemaakt`);
  }

  // Lightspeed dagrapporten → Supabase (ook als er geen facturen zijn)
  const dagrapporten = scanners.flatMap(s => s.dagrapporten || []);
  if (dagrapporten.length && supabase) {
    for (const dr of dagrapporten) {
      if (!dr.datum) { console.warn('[dagrapport] geen datum gevonden — overgeslagen'); continue; }
      const { error } = await supabase.from('dagrapport').upsert({
        datum: dr.datum, restaurant: 'europizza',
        totale_omzet: dr.totale_omzet, bar_omzet: dr.bar_omzet, keuken_omzet: dr.keuken_omzet,
        aantal_gasten: dr.aantal_gasten, aantal_tafels: dr.aantal_tafels, gerechten: dr.gerechten,
      }, { onConflict: 'datum,restaurant' });
      if (error) console.warn('[dagrapport] schrijffout:', error.message);
      else console.log(`[inkoop-bot] dagrapport ${dr.datum} opgeslagen (${dr.gerechten.length} gerechten)`);
    }
  }

  const notion = new NotionSync(settings);

  // Notion → Supabase mirror (alle ingrediënten naar inkoop_prijzen). Draait bij
  // elke scan, ook als er geen nieuwe facturen zijn (vangt handmatige edits mee).
  async function spiegelNaarSupabase() {
    if (!supabase) return;
    try {
      const m = await notion.mirrorNaarSupabase(supabase);
      if (m?.error) console.warn('[mirror] Supabase niet bijgewerkt:', m.error);
      else if (m?.count != null) console.log(`[inkoop-bot] ${m.count} ingrediënten gespiegeld naar Supabase inkoop_prijzen`);
    } catch (e) { console.warn('[mirror] fout:', e.message); }
    try {
      const d = await notion.detecteerDubbels(supabase);
      if (d?.count) console.log(`[inkoop-bot] ${d.count} mogelijk-dubbel melding(en) aangemaakt`);
    } catch (e) { console.warn('[dubbel] fout:', e.message); }
  }

  if (results.length === 0) {
    console.log('[inkoop-bot] Geen nieuwe facturen gevonden.');
    await spiegelNaarSupabase();
    return;
  }

  // Lerende non-food blacklist uit Supabase laden (groeit als app ingrediënten archiveert)
  let learnedBlacklist = [];
  if (supabase) {
    try {
      const { data, error } = await supabase.from('non_food_blacklist').select('naam');
      if (!error && data) learnedBlacklist = data.map(r => r.naam);
    } catch (e) { console.warn('[blacklist] non_food_blacklist niet geladen:', e.message); }
  }

  // HSN-leverancier, non-food en lerende blacklist weren vóór verwerking
  const { kept, blocked } = NotionSync.filterScanItems(results, learnedBlacklist);
  const totaalGeweerd = blocked.hsn.length + blocked.nonFood.length + (blocked.drank?.length || 0) + blocked.learned.length;
  if (totaalGeweerd) {
    console.log(`[filter] ${totaalGeweerd} producten geweerd — HSN:${blocked.hsn.length}, non-food:${blocked.nonFood.length}, drank:${blocked.drank?.length || 0}, blacklist:${blocked.learned.length}`);
  }
  if (kept.length === 0) {
    console.log('[inkoop-bot] Geen verwerkbare producten na filtering.');
    return;
  }

  // Datum-varianten in productnamen samenvoegen ("asperges aa ongeschild 2-6" +
  // "...5-6" → één product "asperges aa ongeschild"). hoofdItems = één entry per
  // basisnaam met de meest recente prijs; historieItems = élke datumvariant als
  // los prijspunt voor de Inkoop Geschiedenis.
  const { hoofdItems, historieItems } = NotionSync.collapseDatumVarianten(kept);

  const notionPrices = await notion.getAllPrices();
  // Lookup op naam ÉN alias — zo herkent de bot eerder samengevoegde producten
  // (de oude naam leeft voort als alias) en maakt hij ze niet opnieuw aan.
  const naamMap = {};
  const idx = (sleutel, e) => { const k = String(sleutel || '').toLowerCase().trim(); if (k && !naamMap[k]) naamMap[k] = e; };
  for (const e of notionPrices) {
    idx(e.name, e);
    // Match ook op de gestripte basisnaam: producten die ooit met datum-suffix in
    // Notion zijn aangemaakt ("asperges aa groen 5-6") matchen zo alsnog met de
    // nieuwe gestripte basisnaam ("asperges aa groen") → geen re-creatie / loop.
    idx(NotionSync.stripDatum(e.name), e);
    for (const a of (e.aliassen || [])) { idx(a, e); idx(NotionSync.stripDatum(a), e); }
  }

  const alerts = [];
  const nieuweItems = [];
  for (const item of hoofdItems) {
    const naam = item.ingredient.toLowerCase().trim();
    const existing = naamMap[naam];

    if (existing) {
      const diff = existing.price ? ((item.price - existing.price) / existing.price) * 100 : 0;
      const pctAbs = Math.abs(diff);

      if (pctAbs >= settings.alertThreshold) {
        // Grote wijziging: Notion update uitstellen — gebruiker moet accepteren
        alerts.push({ ingredient: item.ingredient, oldPrice: existing.price, newPrice: item.price, diff: diff.toFixed(1) });
        await schrijfMelding({
          type: 'prijs_groot',
          ingredient_naam: naam,
          leverancier: item.leverancier || '',
          prijs_oud: existing.price,
          prijs_nieuw: item.price,
          wijziging_pct: parseFloat(diff.toFixed(2)),
          bestaand_page_id: existing.pageId,
          status: 'pending',
          gelezen: false,
        });
        console.log(`  ⚠ GROOT: "${naam}" €${existing.price} → €${item.price} (${diff.toFixed(1)}%) — wacht op bevestiging`);
      } else {
        // Kleine wijziging: meteen bijwerken
        await notion.updatePriceOnly(existing.pageId, item.price, item.leverancier, existing.leverancier, NotionSync.bouwRawData(item));
        // Koppeling: de bot herkent voor het eerst een HANDMATIG ingevoerd product
        // (had nog geen bot-rawdata) → "koppeling gemaakt" melding (groen).
        if (!(existing.rawData && existing.rawData.trim())) {
          await schrijfMelding({
            type: 'koppeling',
            ingredient_naam: naam,
            leverancier: item.leverancier || '',
            prijs_oud: existing.price,
            prijs_nieuw: item.price,
            bestaand_page_id: existing.pageId,
            status: 'pending',
            gelezen: false,
          });
          console.log(`  🔗 KOPPELING: "${naam}" (handmatig) ↔ bot scan via ${item.leverancier}`);
        } else if (pctAbs > 0) {
          await schrijfMelding({
            type: 'prijs_klein',
            ingredient_naam: naam,
            leverancier: item.leverancier || '',
            prijs_oud: existing.price,
            prijs_nieuw: item.price,
            wijziging_pct: parseFloat(diff.toFixed(2)),
            bestaand_page_id: existing.pageId,
            status: 'accepted',
            gelezen: false,
          });
        }
      }
    } else {
      // Nieuw product: verzamelen → straks in batch classificeren (categorie/is_drank)
      nieuweItems.push(item);
    }
  }

  // Nieuwe producten classificeren met Claude Haiku zodat ze de juiste categorie
  // krijgen (zuivel/vlees/vis/groenten/droogwaren/specerijen/drank) i.p.v. de oude
  // standaard 'droogwaren'. Naam blijft de basisnaam (zodat de prijshistorie matcht).
  if (nieuweItems.length) {
    let classified = [];
    try { classified = await notion.classify(nieuweItems); }
    catch (e) { console.warn('[classify] mislukt, val terug op standaard categorie:', e.message); }
    for (const item of nieuweItems) {
      const naam = item.ingredient.toLowerCase().trim();
      const cls = classified.find(c => (c.original || '').toLowerCase().trim() === naam) || {};
      const categorie = cls.categorie || 'droogwaren';
      const drank = cls.is_drank || NotionSync.isDrank(naam);
      await notion.createProduct({ ...item, categorie, isDrank: drank });
      await schrijfMelding({
        type: 'nieuw_product',
        ingredient_naam: naam,
        leverancier: item.leverancier || '',
        prijs_nieuw: item.price,
        status: 'pending',
        gelezen: false,
      });
      console.log(`  ✨ NIEUW: "${naam}" (${categorie}${drank ? ', drank' : ''}) via ${item.leverancier}`);
    }
  }

  await notion.saveHistory(historieItems);
  await spiegelNaarSupabase();

  if (alerts.length) {
    console.log(`[inkoop-bot] ${alerts.length} grote prijswijziging(en) — wachten op bevestiging in app:`);
    alerts.forEach(a => console.log(`  ⚠ ${a.ingredient}: €${a.oldPrice} → €${a.newPrice} (${a.diff}%)`));
  } else {
    console.log('[inkoop-bot] Geen grote prijsafwijkingen.');
  }

  console.log('[inkoop-bot] Klaar.');
}

run().catch(e => { console.error('[inkoop-bot] Fout:', e.message); process.exit(1); });
