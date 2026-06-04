#!/usr/bin/env node
const ImapScanner = require('./src/imap-scanner');
const NotionSync = require('./src/notion-sync');
const path = require('path');
const fs = require('fs');

let _sf = {};
try { _sf = JSON.parse(fs.readFileSync(path.join(__dirname, 'settings.json'), 'utf8')); } catch {}
const settings = {
  imapHost:        process.env.IMAP_HOST         || _sf.imapHost        || 'imap.one.com',
  imapPort:        process.env.IMAP_PORT         || _sf.imapPort        || '993',
  imapUser:        process.env.IMAP_USER         || _sf.imapUser,
  imapPass:        process.env.IMAP_PASS         || _sf.imapPass,
  imapUser2:       process.env.IMAP_USER2        || _sf.imapUser2,
  imapPass2:       process.env.IMAP_PASS2        || _sf.imapPass2,
  notionToken:     process.env.NOTION_TOKEN      || _sf.notionToken,
  notionDbId:      process.env.NOTION_DB_ID      || _sf.notionDbId      || 'b6258a232e6d4482b7b4f50cf449854f',
  anthropicKey:    process.env.ANTHROPIC_API_KEY || _sf.anthropicKey,
  alertThreshold:  parseInt(process.env.ALERT_THRESHOLD || '') || _sf.alertThreshold || 10,
};

const required = { notionToken: 'NOTION_TOKEN', imapUser: 'IMAP_USER', imapPass: 'IMAP_PASS', anthropicKey: 'ANTHROPIC_API_KEY' };
for (const [key, env] of Object.entries(required)) {
  if (!settings[key]) throw new Error(`Ontbrekende instelling "${key}" — stel env var ${env} in of voeg toe aan settings.json`);
}
const dryRun = process.argv.includes('--dry-run');

async function run() {
  const start = new Date().toISOString();
  console.log('\n=== Inkoop Bot scan — ' + start + (dryRun ? ' [DRY-RUN]' : '') + ' ===\n');

  const scanner1 = new ImapScanner(settings);
  const items1 = await scanner1.scan({ markSeen: !dryRun });

  let items2 = [];
  if (settings.imapUser2 && settings.imapPass2) {
    const scanner2 = new ImapScanner({ ...settings, imapUser: settings.imapUser2, imapPass: settings.imapPass2 });
    items2 = await scanner2.scan({ markSeen: !dryRun });
  }

  // Dedupliceer over beide mailboxen
  const map = {};
  for (const item of [...items1, ...items2]) {
    const key = item.ingredient.toLowerCase().trim();
    if (!map[key]) {
      map[key] = { ...item, ingredient: key, count: 1 };
    } else {
      map[key].price = (map[key].price * map[key].count + item.price) / (map[key].count + 1);
      map[key].count++;
      if (item.leverancier && !(map[key].leverancier || '').includes(item.leverancier)) {
        map[key].leverancier = (map[key].leverancier ? map[key].leverancier + ', ' : '') + item.leverancier;
      }
    }
  }

  const items = Object.values(map);
  console.log('Gescand: ' + items.length + ' producten uit facturen');

  if (items.length === 0) {
    console.log('Geen nieuwe facturen gevonden.');
    return;
  }

  if (dryRun) {
    console.log('\nProducten gevonden:');
    items.forEach(i => console.log(`  • ${i.ingredient} — €${i.price}/${i.eenheid} (${i.leverancier})`));
  }

  const notion = new NotionSync(settings);
  const result = await notion.syncAll(items, { dryRun });

  console.log('\n--- Resultaat ---');
  console.log(`  Bijgewerkt : ${result.updated}`);
  console.log(`  Alias match: ${result.aliasAdded}`);
  console.log(`  Nieuw      : ${result.created}`);
  if (dryRun) {
    console.log('\n✋ Dry-run klaar — niets geschreven naar Notion.');
    console.log('   Voer uit zonder --dry-run voor de echte sync.\n');
  } else {
    console.log('\nKlaar!');
    fs.appendFileSync(
      path.join(__dirname, 'scan-log.txt'),
      start + ' — ' + items.length + ' producten (' + result.updated + ' updated, ' + result.aliasAdded + ' alias, ' + result.created + ' nieuw)\n'
    );
  }
}

run().catch(e => { console.error('\nFout:', e.message); process.exit(1); });
