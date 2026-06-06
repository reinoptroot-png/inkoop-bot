/**
 * Headless runner — geen Electron nodig.
 * Leest config uit .env of omgevingsvariabelen.
 * Gebruik: node src/headless.js
 *          node src/headless.js --rescan   (ook al gelezen emails, afgelopen 7 dagen)
 */
require('dotenv').config();

const ImapScanner = require('./imap-scanner');
const NotionSync  = require('./notion-sync');

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
const scanOpts = rescan
  ? { reprocess: true, lookbackDays: 7, markSeen: false }
  : {};

async function run() {
  const missing = ['imapUser', 'imapPass', 'notionToken', 'notionDbId', 'anthropicKey']
    .filter(k => !settings[k]);
  if (missing.length) {
    console.error('Ontbrekende omgevingsvariabelen:', missing.join(', '));
    process.exit(1);
  }

  console.log(`[inkoop-bot] Scan gestart — ${new Date().toISOString()}${rescan ? ' (--rescan: ook gelezen emails)' : ''}`);

  const scanPromises = [];
  if (settings.imapUser && settings.imapPass)
    scanPromises.push(new ImapScanner({ ...settings }).scan(scanOpts));
  if (settings.imapUser2 && settings.imapPass2)
    scanPromises.push(new ImapScanner({ ...settings, imapUser: settings.imapUser2, imapPass: settings.imapPass2 }).scan(scanOpts));
  if (settings.imapUser3 && settings.imapPass3)
    scanPromises.push(new ImapScanner({ ...settings, imapUser: settings.imapUser3, imapPass: settings.imapPass3 }).scan(scanOpts));

  const results = (await Promise.all(scanPromises)).flat();
  console.log(`[inkoop-bot] ${results.length} items gescand`);

  if (results.length === 0) {
    console.log('[inkoop-bot] Geen nieuwe facturen gevonden.');
    return;
  }

  const notion = new NotionSync(settings);
  const notionPrices = await notion.getAllPrices();

  const alerts = [];
  for (const item of results) {
    const existing = notionPrices.find(n =>
      n.name.toLowerCase().trim() === item.ingredient.toLowerCase().trim()
    );
    if (existing) {
      const diff = ((item.price - existing.price) / existing.price) * 100;
      if (Math.abs(diff) >= settings.alertThreshold) {
        alerts.push({ ingredient: item.ingredient, oldPrice: existing.price, newPrice: item.price, diff: diff.toFixed(1) });
      }
    }
    if (existing) {
      await notion.updatePriceOnly(existing.pageId, item.price, item.leverancier);
    } else {
      await notion.createProduct(item);
    }
  }

  if (alerts.length) {
    console.log(`[inkoop-bot] ${alerts.length} alert(s):`);
    alerts.forEach(a => console.log(`  ⚠ ${a.ingredient}: €${a.oldPrice} → €${a.newPrice} (${a.diff}%)`));
  } else {
    console.log('[inkoop-bot] Geen prijsafwijkingen boven drempelwaarde.');
  }

  console.log('[inkoop-bot] Klaar.');
}

run().catch(e => { console.error('[inkoop-bot] Fout:', e.message); process.exit(1); });
