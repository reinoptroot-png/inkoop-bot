#!/usr/bin/env node
const path = require('path');
// scan.js draaide tot nu toe zonder dotenv (alle instellingen kwamen via settings.json-fallbacks) —
// prima totdat notion-sync.js's duplicaat-fallback SUPABASE_DB_URL nodig had, die alleen in .env
// staat (niet in settings.json). Zonder dit faalde die fallback met "SUPABASE_DB_URL ontbreekt".
require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });
const ImapScanner = require('./src/imap-scanner');
const NotionSync = require('./src/notion-sync');
const { createClient } = require('@supabase/supabase-js');
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
  supabaseKey:     process.env.SUPABASE_KEY      || process.env.SUPABASE_ANON_KEY || _sf.supabaseKey,
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
        // pakbon@europa.rest liep herhaaldelijk vast op 30s (mailbox 1/2 op dezelfde host/poort wél
        // binnen die tijd) — waarschijnlijk gewoon een tragere mailbox, geen auth-probleem. Ruimere
        // marge als eerste, goedkope mitigatie; als 't blijft mislukken zit het dieper (server-kant).
        // Update 2026-07-13: de timeout omvat óók het Claude-parsen van de PDF's, dus 60s was zelfs
        // voor een normale dag pakbonnen te krap (meerdere PDF's × parsetijd). Nu 3 min standaard;
        // voor een inhaalslag overschrijfbaar via IMAP_TIMEOUT_MS. Verwerkte mails staan per stuk in
        // het verwerkt-ledger, dus een afgebroken run gaat de volgende keer verder waar 'ie was.
        const timeoutMs = parseInt(process.env.IMAP_TIMEOUT_MS || '', 10) || 180000;
        const items = await Promise.race([
          scanner.scan(opts),
          new Promise((_, rej) => setTimeout(() => rej(new Error(`IMAP timeout na ${timeoutMs / 1000}s`)), timeoutMs)),
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

  const scanOpts = { markSeen: !dryRun, dryRun, reprocess, lookbackDays: 30 };

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

  // Tijdstip van deze scan vastleggen (ook zonder nieuwe emails) → Dashboard "Laatste scan".
  // Niet in dry-run: anders lijkt op het dashboard een echte scan gedraaid te hebben.
  if (!dryRun && settings.supabaseUrl && settings.supabaseKey) {
    const sb = createClient(settings.supabaseUrl, settings.supabaseKey);
    const nu = new Date().toISOString();
    const { error } = await sb.from('instellingen').upsert(
      { restaurant: 'europizza', key: 'laatste_scan', value: nu, updated_at: nu },
      { onConflict: 'restaurant,key' });
    if (error) console.warn('[scan] laatste_scan niet opgeslagen:', error.message);
  }

  // Lightspeed dagrapporten → Supabase (ook als er geen facturen zijn)
  const dagrapporten = allesScanners.flatMap(s => s.dagrapporten || []);
  if (!dryRun && dagrapporten.length && settings.supabaseUrl && settings.supabaseKey) {
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

  // Factuurtotalen → Supabase inkoop_facturen (echte ingekochte euro's per factuur).
  // headless.js schreef dit al; het launchd-pad via scan.js nog niet — het dashboard
  // leest hieruit de inkoop-per-dag. Upsert op factuurnr voorkomt dubbels.
  const facturen = allesScanners.flatMap(s => s.facturen || []);
  if (!dryRun && facturen.length && settings.supabaseUrl && settings.supabaseKey) {
    const sb = createClient(settings.supabaseUrl, settings.supabaseKey);
    const { error } = await sb.from('inkoop_facturen').upsert(facturen, { onConflict: 'factuurnr' });
    console.log(error ? `[facturen] schrijffout: ${error.message}` : `${facturen.length} factuurtotaal(en) → inkoop_facturen`);
  }

  // Dedup over alle mailboxen: laatste factuurprijs wint (F-08) — gedeelde pure functie,
  // geen middeling en geen leverancier-samenvoeging meer (dat brak de artikelnr-index).
  const items = ImapScanner.dedupLaatstePrijs([...items1, ...items2, ...items3, ...items4]);
  console.log('Gescand: ' + items.length + ' producten uit facturen');

  const notion = new NotionSync(settings);
  let result = null;

  if (items.length === 0) {
    console.log('Geen nieuwe facturen gevonden.');
  } else {
    if (dryRun) {
      console.log('\nProducten gevonden:');
      items.forEach(i => console.log(`  • ${i.ingredient} — €${i.price}/${i.eenheid} (${i.leverancier})`));
    }

    const learnedBlacklist = await loadLearnedBlacklist(settings);
    if (learnedBlacklist.length) console.log('Lerende blacklist:', learnedBlacklist.length, 'namen geladen');
    // F-03: zelfde prijspoort als headless — drempel uit settings (ALERT_THRESHOLD, default 10),
    // meldingen naar scan_meldingen (zonder Supabase alleen het poort-besluit, geen melding).
    const poortSb = (settings.supabaseUrl && settings.supabaseKey) ? createClient(settings.supabaseUrl, settings.supabaseKey) : null;
    result = await notion.syncAll(items, { dryRun, learnedBlacklist, prijsPoort: { drempelPct: settings.alertThreshold, supabase: poortSb } });
    if (result.poort) console.log(`Prijspoort: ${result.poort} grote prijssprong(en) wachten op bevestiging (scan_meldingen)`);
  }

  // Notion → Supabase mirror (alle ingrediënten naar inkoop_prijzen).
  // Draait óók zonder nieuwe facturen, zodat Supabase inkoop_prijzen (→ Dashboard
  // "Producten") in sync blijft; stond voorheen ná de early-return en werd dan overgeslagen.
  if (!dryRun && settings.supabaseUrl && settings.supabaseKey) {
    try {
      const sb = createClient(settings.supabaseUrl, settings.supabaseKey);
      // Dubbelen samenvoegen vóór de mirror (o.a. zelfde leverancier+artikelnr → één rij;
      // receptuur-verwijzingen worden in Supabase omgehangen) — zie autoMerge in notion-sync.
      try {
        const am = await notion.autoMerge(sb);
        if (am?.merged) console.log(`  ${am.merged} dubbel(en) automatisch samengevoegd`);
      } catch (e) { console.warn('[auto-merge] fout:', e.message); }
      const m = await notion.mirrorNaarSupabase(sb);
      if (m?.count != null) console.log(`  ${m.count} ingrediënten gespiegeld naar Supabase inkoop_prijzen`);
    } catch (e) { console.warn('[mirror] fout:', e.message); }
  }

  // Geen nieuwe facturen → mirror is gedaan, resultaat-samenvatting overslaan.
  if (!result) return;

  console.log('\n--- Resultaat ---');
  console.log(`  Bijgewerkt : ${result.updated}`);
  console.log(`  Alias match: ${result.aliasAdded}`);
  console.log(`  Nieuw      : ${result.created}`);
  if (dryRun) {
    console.log('\n✋ Dry-run klaar — niets geschreven naar Notion.');
    console.log('   Voer uit zonder --dry-run voor de echte sync.\n');
  } else {
    console.log('\nKlaar!');
    // Log-rotatie: houd max de laatste 90 regels bij (L-07 — voorheen onbeperkt appenden).
    const logPad = path.join(__dirname, 'scan-log.txt');
    const nieuweRegel = start + ' — ' + items.length + ' producten (' + result.updated + ' updated, ' + result.aliasAdded + ' alias, ' + result.created + ' nieuw)';
    let regels = [];
    try { regels = fs.readFileSync(logPad, 'utf8').split('\n').filter(Boolean); } catch {}
    regels.push(nieuweRegel);
    fs.writeFileSync(logPad, regels.slice(-90).join('\n') + '\n');
    // Herbereken bereiding_kostprijs zodat gewijzigde inkoopprijzen direct doorwerken in plates
    const computeUrl = process.env.COMPUTE_URL || _sf.computeUrl;
    if (computeUrl && (result.updated > 0 || result.created > 0)) {
      try {
        const fetch = require('node-fetch');
        const resp = await fetch(computeUrl, { method: 'POST', timeout: 25000 });
        const data = await resp.json();
        console.log(`[compute] ${data.aantal ?? '?'} bereidingen herberekend`);
      } catch (e) {
        console.warn('[compute] herberekening mislukt:', e.message);
      }
    }
  }
}

run()
  .then(() => {
    const { execFileSync } = require('child_process');
    // Nieuwe recepten promoten naar de Recept Database (bereiding). --only-new leest alleen de
    // tabellen van recepten zónder bestaande bereiding → snel, geen timeout op 600 pagina's, en
    // raakt bestaande bereidingen niet aan. Onzekere regels gaan naar bereiding_import_review;
    // de koppel-review-stap hierna lost die met Haiku op (daarom hier --no-haiku: geen dubbele
    // ronde). Niet in dry-run: dan mag niets naar Supabase geschreven worden.
    if (!dryRun) {
      try {
        console.log('\n--- recepten promoten (nieuw) ---');
        execFileSync('/usr/local/bin/node', ['import-recepten.js', '--commit', '--only-new', '--no-haiku'], { stdio: 'inherit', timeout: 600000 });
      } catch (e) {
        console.warn('[import-recepten] fout:', e.message);
      }
    }
    // Na de scan: bereiding-regels automatisch oplossen (koppel-review --commit).
    try {
      console.log('\n--- koppel-review ---');
      // 120s was te krap geworden: bij de huidige review-achterstand (291 items, Haiku-fallback
      // ~1.2/s) duurt een volledige koppel-review-run ~4 minuten, dus de oude timeout kapte 'm
      // halverwege af — elke dag opnieuw, zonder dat de achterstand ooit kromp. 10 minuten geeft
      // ruim marge; de volgende cronjob (platessync, 12:20) start pas 20 minuten na deze.
      execFileSync('/usr/local/bin/node', ['koppel-review.js', '--commit'], { stdio: 'inherit', timeout: 600000 });
    } catch (e) {
      console.warn('[koppel-review] fout:', e.message);
    }
  })
  .catch(e => {
    console.error('\nFout:', e.message);
    console.error(e.stack);
    process.exit(1);
  });
