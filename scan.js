#!/usr/bin/env node
const ImapScanner = require('./src/imap-scanner');
const NotionSync = require('./src/notion-sync');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const fs = require('fs');

// Lerende non-food blacklist laden (zelfde bron als headless.js).
// Bij ontbrekende/onbereikbare Supabase → [], zodat HSN + NON_FOOD_BLACKLIST
// (die in syncAll zelf zitten) gewoon blijven werken.
async function loadLearnedBlacklist(settings) {
  if (!settings.supabaseUrl || !settings.supabaseKey) return [];
  try {
    const sb = createClient(settings.supabaseUrl, settings.supabaseKey);
    const { data, error } = await sb.from('non_food_blacklist').select('naam');
    if (error) { console.warn('[blacklist] niet geladen:', error.message); return []; }
    return (data || []).map(r => r.naam);
  } catch (e) { console.warn('[blacklist] fout:', e.message); return []; }
}

let _sf = {};
try { _sf = JSON.parse(fs.readFileSync(path.join(__dirname, 'settings.json'), 'utf8')); } catch {}
const settings = {
  imapHost:        process.env.IMAP_HOST         || _sf.imapHost        || 'imap.one.com',
  imapPort:        process.env.IMAP_PORT         || _sf.imapPort        || '993',
  imapUser:        process.env.IMAP_USER         || _sf.imapUser,
  imapPass:        process.env.IMAP_PASS         || _sf.imapPass,
  imapUser2:       process.env.IMAP_USER2        || _sf.imapUser2,
  imapPass2:       process.env.IMAP_PASS2        || _sf.imapPass2,
  imapHost2:       process.env.IMAP_HOST2        || _sf.imapHost2       || null,
  imapUser3:       process.env.IMAP_USER3        || _sf.imapUser3,
  imapPass3:       process.env.IMAP_PASS3        || _sf.imapPass3,
  imapHost3:       process.env.IMAP_HOST3        || _sf.imapHost3       || null,
  notionToken:     process.env.NOTION_TOKEN      || process.env.notionToken      || _sf.notionToken,
  notionDbId:      process.env.NOTION_DB_ID      || process.env.notionDbId       || _sf.notionDbId      || 'b6258a232e6d4482b7b4f50cf449854f',
  anthropicKey:    process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_KEY    || _sf.anthropicKey,
  alertThreshold:  parseInt(process.env.ALERT_THRESHOLD || '') || _sf.alertThreshold || 10,
  supabaseUrl:     process.env.SUPABASE_URL      || _sf.supabaseUrl,
  supabaseKey:     process.env.SUPABASE_KEY      || _sf.supabaseKey,
};

const required = { notionToken: 'NOTION_TOKEN', imapUser: 'IMAP_USER', imapPass: 'IMAP_PASS', anthropicKey: 'ANTHROPIC_KEY (of ANTHROPIC_API_KEY)' };
for (const [key, env] of Object.entries(required)) {
  if (!settings[key]) throw new Error(`Ontbrekende instelling "${key}" — stel env var ${env} in of voeg toe aan settings.json`);
}
const dryRun    = process.argv.includes('--dry-run');
const reprocess = process.argv.includes('--reprocess');

async function run() {
  const start = new Date().toISOString();
  console.log('\n=== Inkoop Bot scan — ' + start + (dryRun ? ' [DRY-RUN]' : '') + ' ===\n');

  console.log('Verbinding maken met IMAP:', settings.imapUser, '@', settings.imapHost);
  const scanner1 = new ImapScanner(settings);
  const items1 = await scanner1.scan({ markSeen: !dryRun, reprocess, lookbackDays: 30 });
  console.log('IMAP 1 OK —', items1.length, 'producten');

  let items2 = [];
  let scanner2 = null;
  if (settings.imapUser2 && settings.imapPass2) {
    const host2 = settings.imapHost2 || settings.imapHost;
    console.log('Verbinding maken met IMAP:', settings.imapUser2, '@', host2);
    const cfg2 = { ...settings, imapUser: settings.imapUser2, imapPass: settings.imapPass2, imapHost: host2 };
    let imap2Ok = false;
    const scanMetTimeout = (cfg, opts, ms) => Promise.race([
      new ImapScanner(cfg).scan(opts),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`IMAP timeout na ${ms / 1000}s`)), ms)),
    ]);
    for (let poging = 1; poging <= 3; poging++) {
      try {
        items2 = await scanMetTimeout(cfg2, { markSeen: !dryRun, reprocess, lookbackDays: 30 }, 30000);
        console.log('IMAP 2 OK —', items2.length, 'producten');
        imap2Ok = true;
        break;
      } catch (e) {
        console.warn(`IMAP 2 poging ${poging}/3 mislukt: ${e.message}`);
        if (poging < 3) await new Promise(r => setTimeout(r, 3000));
      }
    }
    if (!imap2Ok) {
      console.warn('⚠️  IMAP 2 (europa.rest) overgeslagen na 3 pogingen — scan gaat door zonder tweede mailbox');
      scanner2 = null;
    }
  }

  let items3 = [];
  if (settings.imapUser3 && settings.imapPass3) {
    const host3 = settings.imapHost3 || settings.imapHost;
    console.log('Verbinding maken met IMAP:', settings.imapUser3, '@', host3);
    const cfg3 = { ...settings, imapUser: settings.imapUser3, imapPass: settings.imapPass3, imapHost: host3 };
    let imap3Ok = false;
    const scanMetTimeout3 = (cfg, opts, ms) => Promise.race([
      new ImapScanner(cfg).scan(opts),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`IMAP timeout na ${ms / 1000}s`)), ms)),
    ]);
    for (let poging = 1; poging <= 3; poging++) {
      try {
        items3 = await scanMetTimeout3(cfg3, { markSeen: !dryRun, reprocess, lookbackDays: 30 }, 30000);
        console.log('IMAP 3 OK —', items3.length, 'producten');
        imap3Ok = true;
        break;
      } catch (e) {
        console.warn(`IMAP 3 poging ${poging}/3 mislukt: ${e.message}`);
        if (poging < 3) await new Promise(r => setTimeout(r, 3000));
      }
    }
    if (!imap3Ok) {
      console.warn('⚠️  IMAP 3 (pakbon@europa.rest) overgeslagen na 3 pogingen — scan gaat door zonder derde mailbox');
    }
  }

  // Nieuwe food-leverancier kandidaten → meldingen (dedup gebeurt in de helper)
  const kandidaten = [...(scanner1.nieuweLeveranciers || []), ...(scanner2 ? (scanner2.nieuweLeveranciers || []) : [])];
  if (kandidaten.length) {
    const n = await ImapScanner.schrijfNieuweLeverancierMeldingen(settings.supabaseUrl, settings.supabaseKey, kandidaten);
    if (n) console.log(`Nieuwe leverancier-meldingen aangemaakt: ${n}`);
  }

  // Tijdstip van deze scan vastleggen (ook zonder nieuwe emails) → Dashboard "Laatste scan"
  if (settings.supabaseUrl && settings.supabaseKey) {
    const sb = createClient(settings.supabaseUrl, settings.supabaseKey);
    const nu = new Date().toISOString();
    const { error } = await sb.from('instellingen').upsert(
      { restaurant: 'europizza', key: 'laatste_scan', value: nu, updated_at: nu },
      { onConflict: 'restaurant,key' });
    if (error) console.warn('[scan] laatste_scan niet opgeslagen:', error.message);
  }

  // Lightspeed dagrapporten → Supabase (ook als er geen facturen zijn)
  const dagrapporten = [...(scanner1.dagrapporten || []), ...(scanner2 ? (scanner2.dagrapporten || []) : [])];
  if (dagrapporten.length && settings.supabaseUrl && settings.supabaseKey) {
    const sb = createClient(settings.supabaseUrl, settings.supabaseKey);
    for (const dr of dagrapporten) {
      if (!dr.datum) { console.warn('[dagrapport] geen datum — overgeslagen'); continue; }
      const { error } = await sb.from('dagrapport').upsert({
        datum: dr.datum, restaurant: 'europizza',
        totale_omzet: dr.totale_omzet, bar_omzet: dr.bar_omzet, keuken_omzet: dr.keuken_omzet,
        aantal_gasten: dr.aantal_gasten, aantal_tafels: dr.aantal_tafels, gerechten: dr.gerechten,
      }, { onConflict: 'datum,restaurant' });
      console.log(error ? `[dagrapport] schrijffout: ${error.message}` : `dagrapport ${dr.datum} opgeslagen (${dr.gerechten.length} gerechten)`);
    }
  }

  // Dedupliceer over alle mailboxen
  const map = {};
  for (const item of [...items1, ...items2, ...items3]) {
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

  const learnedBlacklist = await loadLearnedBlacklist(settings);
  if (learnedBlacklist.length) console.log('Lerende blacklist:', learnedBlacklist.length, 'namen geladen');
  const notion = new NotionSync(settings);
  const result = await notion.syncAll(items, { dryRun, learnedBlacklist });

  // Notion → Supabase mirror (alle ingrediënten naar inkoop_prijzen)
  if (!dryRun && settings.supabaseUrl && settings.supabaseKey) {
    try {
      const sb = createClient(settings.supabaseUrl, settings.supabaseKey);
      const m = await notion.mirrorNaarSupabase(sb);
      if (m?.count != null) console.log(`  ${m.count} ingrediënten gespiegeld naar Supabase inkoop_prijzen`);
    } catch (e) { console.warn('[mirror] fout:', e.message); }
  }

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

run()
  .then(() => {
    // Na de scan: bereiding-regels automatisch oplossen (koppel-review --commit).
    const { execFileSync } = require('child_process');
    try {
      console.log('\n--- koppel-review ---');
      execFileSync('/usr/local/bin/node', ['koppel-review.js', '--commit'], { stdio: 'inherit', timeout: 120000 });
    } catch (e) {
      console.warn('[koppel-review] fout:', e.message);
    }
  })
  .catch(e => {
    console.error('\nFout:', e.message);
    console.error(e.stack);
    process.exit(1);
  });
