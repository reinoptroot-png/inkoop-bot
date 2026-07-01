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
  imapUser4:       process.env.IMAP_USER4        || _sf.imapUser4,
  imapPass4:       process.env.IMAP_PASS4        || _sf.imapPass4,
  imapHost4:       process.env.IMAP_HOST4        || _sf.imapHost4       || null,
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

  // Helper: scan één mailbox met retry + timeout; geeft { items, scanner } terug
  const scanMailbox = async (nr, user, pass, host, opts) => {
    const cfg = { ...settings, imapUser: user, imapPass: pass, imapHost: host || settings.imapHost };
    console.log(`Verbinding maken met IMAP ${nr}:`, user, '@', cfg.imapHost);
    for (let poging = 1; poging <= 3; poging++) {
      try {
        const scanner = new ImapScanner(cfg);
        const items = await Promise.race([
          scanner.scan(opts),
          new Promise((_, rej) => setTimeout(() => rej(new Error('IMAP timeout na 30s')), 30000)),
        ]);
        console.log(`IMAP ${nr} OK —`, items.length, 'producten');
        return { items, scanner };
      } catch (e) {
        console.warn(`IMAP ${nr} poging ${poging}/3 mislukt: ${e.message}`);
        if (poging < 3) await new Promise(r => setTimeout(r, 3000));
      }
    }
    console.warn(`⚠️  IMAP ${nr} (${user}) overgeslagen na 3 pogingen`);
    return { items: [], scanner: null };
  };

  const scanOpts = { markSeen: !dryRun, reprocess, lookbackDays: 30 };

  const { items: items1, scanner: scanner1 } = await scanMailbox(1, settings.imapUser, settings.imapPass, settings.imapHost, scanOpts);
  const { items: items2, scanner: scanner2 } = settings.imapUser2
    ? await scanMailbox(2, settings.imapUser2, settings.imapPass2, settings.imapHost2, scanOpts)
    : { items: [], scanner: null };
  const { items: items3, scanner: scanner3 } = settings.imapUser3
    ? await scanMailbox(3, settings.imapUser3, settings.imapPass3, settings.imapHost3, scanOpts)
    : { items: [], scanner: null };
  const { items: items4, scanner: scanner4 } = settings.imapUser4
    ? await scanMailbox(4, settings.imapUser4, settings.imapPass4, settings.imapHost4, scanOpts)
    : { items: [], scanner: null };

  const allesScanners = [scanner1, scanner2, scanner3, scanner4].filter(Boolean);

  // Nieuwe food-leverancier kandidaten → meldingen (dedup gebeurt in de helper)
  const kandidaten = allesScanners.flatMap(s => s.nieuweLeveranciers || []);
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
  const dagrapporten = allesScanners.flatMap(s => s.dagrapporten || []);
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
  for (const item of [...items1, ...items2, ...items3, ...items4]) {
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
