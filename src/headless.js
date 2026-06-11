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

async function schrijfMelding(data) {
  if (!supabase) return;
  try {
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

  if (results.length === 0) {
    console.log('[inkoop-bot] Geen nieuwe facturen gevonden.');
    return;
  }

  const notion = new NotionSync(settings);

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
  const totaalGeweerd = blocked.hsn.length + blocked.nonFood.length + blocked.learned.length;
  if (totaalGeweerd) {
    console.log(`[filter] ${totaalGeweerd} producten geweerd — HSN:${blocked.hsn.length}, non-food:${blocked.nonFood.length}, blacklist:${blocked.learned.length}`);
  }
  if (kept.length === 0) {
    console.log('[inkoop-bot] Geen verwerkbare producten na filtering.');
    return;
  }

  const notionPrices = await notion.getAllPrices();

  const alerts = [];
  for (const item of kept) {
    const naam = item.ingredient.toLowerCase().trim();
    const existing = notionPrices.find(n => n.name === naam);

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
        await notion.updatePriceOnly(existing.pageId, item.price, item.leverancier, existing.leverancier);
        if (pctAbs > 0) {
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
      // Nieuw product: aanmaken in Notion + informatieve melding
      await notion.createProduct(item);
      await schrijfMelding({
        type: 'nieuw_product',
        ingredient_naam: naam,
        leverancier: item.leverancier || '',
        prijs_nieuw: item.price,
        status: 'pending',
        gelezen: false,
      });
      console.log(`  ✨ NIEUW: "${naam}" via ${item.leverancier}`);
    }
  }

  await notion.saveHistory(kept);

  if (alerts.length) {
    console.log(`[inkoop-bot] ${alerts.length} grote prijswijziging(en) — wachten op bevestiging in app:`);
    alerts.forEach(a => console.log(`  ⚠ ${a.ingredient}: €${a.oldPrice} → €${a.newPrice} (${a.diff}%)`));
  } else {
    console.log('[inkoop-bot] Geen grote prijsafwijkingen.');
  }

  console.log('[inkoop-bot] Klaar.');
}

run().catch(e => { console.error('[inkoop-bot] Fout:', e.message); process.exit(1); });
