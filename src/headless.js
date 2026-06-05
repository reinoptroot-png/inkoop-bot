/**
 * Headless runner — geen Electron nodig.
 * Leest config uit .env of omgevingsvariabelen.
 * Gebruik: node src/headless.js
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
  notionToken:    process.env.NOTION_TOKEN,
  notionDbId:     process.env.NOTION_DB_ID,
  anthropicKey:   process.env.ANTHROPIC_KEY,
  alertThreshold: parseInt(process.env.ALERT_THRESHOLD || '10', 10),
};

async function run() {
  const missing = ['imapUser', 'imapPass', 'notionToken', 'notionDbId', 'anthropicKey']
    .filter(k => !settings[k]);
  if (missing.length) {
    console.error('Ontbrekende omgevingsvariabelen:', missing.join(', '));
    process.exit(1);
  }

  console.log(`[inkoop-bot] Scan gestart — ${new Date().toISOString()}`);

  const scanPromises = [];
  if (settings.imapUser && settings.imapPass)
    scanPromises.push(new ImapScanner({ ...settings }).scan());
  if (settings.imapUser2 && settings.imapPass2)
    scanPromises.push(new ImapScanner({ ...settings, imapUser: settings.imapUser2, imapPass: settings.imapPass2 }).scan());

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
    await notion.updatePrice({ ...item, pageId: existing?.pageId, isNew: !existing });
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
