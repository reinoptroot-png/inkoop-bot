#!/usr/bin/env node
// Scan-wachter — bewakingsagent voor de facturen/pakbonnen-mailpijplijn (zie WACHTER.md).
//
// Draait onafhankelijk van scan.js via een eigen launchd-job (scripts/setup-wachter.sh,
// elke 30 min). Verwerkt zélf geen mails: hij zoekt gaten, storingen en stille fouten en
// schrijft die idempotent (upsert op gap_id) naar Supabase `scan_wachter_gaten`.
//
// Harde regels (uit de opdracht):
//   - Bewijsplicht: elk gat verwijst naar een Message-ID, logregel of queryresultaat.
//     Wat niet te achterhalen is heet "onbekend" met reden — nooit schatten.
//   - Idempotent: bestaand gap_id → laatst_gezien/retry_teller bijwerken, nooit dupliceren.
//   - Een door een MENS op 'genegeerd' gezet item gaat nooit terug naar 'open'.
//   - Dead-man's switch: elke geslaagde cyclus pingt WACHTER_HEARTBEAT_URL; het UITBLIJVEN
//     daarvan is het externe signaal dat de wachter zelf niet draait.
//   - Mailbox-toegang is strikt read-only (openBox readonly, nooit markSeen, nooit schrijven).
//   - De wachter repareert de pijplijn niet.
//
//   node wachter.js            één cyclus (zo draait launchd 'm)
//   node wachter.js --dry-run  alles detecteren maar niets schrijven/pingen/alarmeren
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const Imap = require('imap');
const fetch = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');

const DRY = process.argv.includes('--dry-run');

// ── Configuratie (env > settings.json > default) ──────────────────────────────
let _sf = {};
try { _sf = JSON.parse(fs.readFileSync(path.join(__dirname, 'settings.json'), 'utf8')); } catch {}
const CFG = {
  supabaseUrl: process.env.SUPABASE_URL || _sf.supabaseUrl,
  supabaseKey: process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || _sf.supabaseKey,
  // Zelfde 4 mailboxen als scan.js — maar hier uitsluitend read-only geopend.
  mailboxen: [
    { nr: 1, user: process.env.IMAP_USER, pass: process.env.IMAP_PASS, host: process.env.IMAP_HOST || _sf.imapHost || 'imap.one.com' },
    { nr: 2, user: process.env.IMAP_USER2, pass: process.env.IMAP_PASS2, host: process.env.IMAP_HOST2 || process.env.IMAP_HOST || _sf.imapHost || 'imap.one.com' },
    { nr: 3, user: process.env.IMAP_USER3, pass: process.env.IMAP_PASS3, host: process.env.IMAP_HOST3 || process.env.IMAP_HOST || _sf.imapHost || 'imap.one.com' },
    { nr: 4, user: process.env.IMAP_USER4, pass: process.env.IMAP_PASS4, host: process.env.IMAP_HOST4 || process.env.IMAP_HOST || _sf.imapHost || 'imap.one.com' },
  ].filter(m => m.user && m.pass),
  // Dead-man's switch + alarmkanaal — bewust extern aan deze machine/pijplijn.
  heartbeatUrl: process.env.WACHTER_HEARTBEAT_URL || null,          // bv. https://hc-ping.com/<uuid>
  alertWebhookUrl: process.env.WACHTER_ALERT_URL || null,           // Slack-compatible: POST {text}
  telegramToken: process.env.WACHTER_TELEGRAM_BOT_TOKEN || null,
  telegramChat: process.env.WACHTER_TELEGRAM_CHAT_ID || null,
  intervalMin: parseInt(process.env.WACHTER_INTERVAL_MIN || '', 10) || 30,
  scanLabel: 'rest.europa.inkoopscan',
  scanVenster: { uur: 12, minuut: 0 },      // dagelijkse scan (setup-scanmachine.sh)
  scanMaxLeeftijdUren: 26,                  // dagelijkse scan + marge; ouder = "scan niet gedraaid"
  kijkvensterDagen: 14,                     // hoe ver terug de wachter mails/facturen vergelijkt
  graceUren: 2,                             // mail jonger dan (laatste_scan − grace) nog niet beoordelen
  factuurDatumMaxOudDagen: 90,              // parse-drempels (opdracht §3)
  factuurDatumMaxToekomstDagen: 7,
  alarmHerhaalUren: 4,
  middenAlarmNaMin: 30,
  logPad: path.join(__dirname, 'scan-log.txt'),
  statePad: path.join(__dirname, 'wachter-state.json'),
};

const NU = new Date();
const CYCLUS_ID = `${NU.toISOString()}|${os.hostname()}`;
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const uur = ms => ms / 3600000;
const log = (...a) => console.log('[wachter]', ...a);

const sb = (CFG.supabaseUrl && CFG.supabaseKey) ? createClient(CFG.supabaseUrl, CFG.supabaseKey) : null;

// ── State (idempotency, heartbeat-geschiedenis, alarm-dedupe, log-offset) ─────
function leesState() {
  try { return JSON.parse(fs.readFileSync(CFG.statePad, 'utf8')); } catch { return {}; }
}
function schrijfState(state) {
  if (DRY) return;
  try { fs.writeFileSync(CFG.statePad, JSON.stringify(state, null, 2)); } catch (e) { console.error('[wachter] state niet geschreven:', e.message); }
}

// ── Gaten verzamelen (dedupe binnen de cyclus op gap_id) ──────────────────────
const gaten = new Map();
const geslaagdeDomeinen = new Set(); // alleen gaten uit een dit-cyclus-geslaagd domein mogen auto-oplossen
function gap({ sleutel, type, ernst, message_id = null, bron, bewijs, details, actie, domein }) {
  const gap_id = sha(`${sleutel}|${type}`);
  if (gaten.has(gap_id)) return;
  gaten.set(gap_id, {
    gap_id, cyclus_id: CYCLUS_ID, message_id, type, ernst,
    bron_verwijzing: bron, bewijs, details, voorgestelde_actie: actie, domein,
  });
}

// ── §1 Machine-gezondheid (alleen zinvol op de scan-machine zelf) ─────────────
function cmd(bin, args) {
  try { return execFileSync(bin, args, { encoding: 'utf8', timeout: 15000 }); } catch { return null; }
}
function checkMachine(state, samenvatting) {
  const lijst = cmd('/bin/launchctl', ['list']);
  const isScanmachine = !!(lijst && lijst.includes(CFG.scanLabel));
  samenvatting.is_scanmachine = isScanmachine;
  if (!isScanmachine) {
    // Bewijsplicht: dit is geen gat maar een vaststelling — machine-checks zijn hier "onbekend".
    samenvatting.machine = `onbekend — launchd-label ${CFG.scanLabel} niet op deze machine (${os.hostname()}); machine-checks draaien alleen op de scan-iMac`;
    return;
  }
  geslaagdeDomeinen.add('machine');

  // Launchd-status + exitcode van de laatste run.
  const jobInfo = cmd('/bin/launchctl', ['list', CFG.scanLabel]) || '';
  const exitMatch = jobInfo.match(/"LastExitStatus"\s*=\s*(-?\d+)/);
  const lastExit = exitMatch ? parseInt(exitMatch[1], 10) : null;
  if (lastExit != null && lastExit !== 0) {
    gap({
      sleutel: `machine|exitcode`, type: 'connectiviteit', ernst: 'hoog', domein: 'machine',
      bron: `launchd ${CFG.scanLabel} op ${os.hostname()}`,
      bewijs: `launchctl list ${CFG.scanLabel}: LastExitStatus = ${lastExit}`,
      details: `De scan-job eindigde met exitcode ${lastExit} (≠ 0) bij de laatste run.`,
      actie: `Bekijk het einde van scan-log.txt op de scan-machine en draai zo nodig handmatig: node scan.js`,
    });
  }

  // Herstart sinds vorige cyclus? En zo ja: draait de job-context (GUI-sessie) weer?
  const boot = cmd('/usr/sbin/sysctl', ['-n', 'kern.boottime']);
  const bootSec = boot && boot.match(/sec = (\d+)/)?.[1];
  const bootTijd = bootSec ? new Date(parseInt(bootSec, 10) * 1000) : null;
  samenvatting.boottime = bootTijd ? bootTijd.toISOString() : 'onbekend — sysctl kern.boottime gaf niets';
  if (bootTijd && state.laatsteCyclus && bootTijd > new Date(state.laatsteCyclus)) {
    // LaunchAgents draaien alleen in een ingelogde GUI-sessie; na een stroomstoring hangt
    // alles op automatisch inloggen. `who` toont of er een console-sessie is.
    const who = cmd('/usr/bin/who', []) || '';
    const guiSessie = /\bconsole\b/.test(who);
    if (!guiSessie) {
      gap({
        sleutel: `machine|herstart-zonder-gui|${bootTijd.toISOString()}`, type: 'connectiviteit', ernst: 'hoog', domein: 'machine',
        bron: `scan-machine ${os.hostname()}`,
        bewijs: `kern.boottime=${bootTijd.toISOString()} > vorige wachter-cyclus ${state.laatsteCyclus}; \`who\` bevat geen console-sessie`,
        details: `Machine is herstart en er is GEEN ingelogde GUI-sessie — LaunchAgents (incl. de scan-job) draaien dan niet.`,
        actie: 'Log in op de iMac (of zet Automatisch inloggen aan: Systeeminstellingen → Gebruikers en groepen).',
      });
    } else {
      samenvatting.herstart = `herstart gedetecteerd (${bootTijd.toISOString()}), GUI-sessie aanwezig — jobs draaien weer`;
    }
  }

  // Slaap gelogd tijdens het verwachte scan-venster (vandaag en gisteren, 11:55–12:35)?
  const pm = cmd('/usr/bin/pmset', ['-g', 'log']);
  if (pm) {
    const slaapInVenster = [];
    for (const dagOffset of [0, 1]) {
      const d = new Date(NU); d.setDate(d.getDate() - dagOffset);
      const dagStr = d.toISOString().slice(0, 10);
      const re = new RegExp(`^${dagStr} 1[12]:\\d{2}:\\d{2}.*(Entering Sleep|Sleep {2}).*`, 'gm');
      for (const m of pm.match(re) || []) {
        const t = m.slice(11, 16);
        if (t >= '11:55' && t <= '12:35') slaapInVenster.push(m.trim().slice(0, 160));
      }
    }
    if (slaapInVenster.length) {
      gap({
        sleutel: `machine|slaap-in-venster|${slaapInVenster[0]}`, type: 'connectiviteit', ernst: 'midden', domein: 'machine',
        bron: `pmset -g log op ${os.hostname()}`,
        bewijs: slaapInVenster[0],
        details: `Slaapmoment gelogd binnen het scan-venster (11:55–12:35) — de 12:00-scan kan daardoor zijn overgeslagen (launchd StartCalendarInterval haalt gemiste runs pas na wake in).`,
        actie: 'Controleer of de laatste scan alsnog gedraaid heeft; check pmset-instellingen (sleep 0).',
      });
    }
  } else {
    samenvatting.pmset = 'onbekend — pmset -g log gaf niets terug';
  }

  // Klokdrift (vervuilt álle timestamp-vergelijkingen). sntp raadpleegt alleen, zet niets.
  const sntp = cmd('/usr/bin/sntp', ['-t', '5', 'time.apple.com']);
  const drift = sntp && sntp.match(/([+-]\d+\.\d+)\s*\+\/-/);
  if (drift) {
    const sec = Math.abs(parseFloat(drift[1]));
    samenvatting.klokdrift_sec = parseFloat(drift[1]);
    if (sec > 120) {
      gap({
        sleutel: 'machine|klokdrift', type: 'connectiviteit', ernst: 'midden', domein: 'machine',
        bron: `sntp time.apple.com op ${os.hostname()}`,
        bewijs: `sntp offset ${drift[1]}s`,
        details: `Systeemklok wijkt ${drift[1]}s af — alle timestamp-vergelijkingen in deze bewaking zijn hierdoor onbetrouwbaar.`,
        actie: 'Zet NTP-synchronisatie aan: Systeeminstellingen → Datum en tijd.',
      });
    }
  } else {
    samenvatting.klokdrift_sec = 'onbekend — sntp gaf geen offset terug';
  }

  // Schijfruimte.
  const df = cmd('/bin/df', ['-k', '/']);
  const pct = df && df.match(/(\d+)%\s+\/\n?$/m);
  if (pct) {
    samenvatting.schijf_gebruikt_pct = parseInt(pct[1], 10);
    if (parseInt(pct[1], 10) > 90) {
      gap({
        sleutel: 'machine|schijf', type: 'connectiviteit', ernst: 'midden', domein: 'machine',
        bron: `df -k / op ${os.hostname()}`, bewijs: `df: ${pct[1]}% in gebruik`,
        details: `Schijf ${pct[1]}% vol — PDF-verwerking en logs kunnen gaan falen.`,
        actie: 'Ruim schijfruimte op de scan-machine op.',
      });
    }
  }

  // Keychain/OAuth: deze pijplijn gebruikt géén Keychain — alle credentials staan in .env
  // (bestand, geen ingelogde sessie nodig). Check dus alleen dat .env bestaat en leesbaar is.
  try {
    fs.accessSync(path.join(__dirname, '.env'), fs.constants.R_OK);
    samenvatting.credentials = '.env leesbaar (pijplijn gebruikt geen Keychain — geen sessie-afhankelijke auth)';
  } catch {
    gap({
      sleutel: 'machine|env-onleesbaar', type: 'connectiviteit', ernst: 'hoog', domein: 'machine',
      bron: path.join(__dirname, '.env'), bewijs: 'fs.access R_OK faalde op .env',
      details: '.env is niet leesbaar — de scan kan niet authenticeren.',
      actie: 'Herstel .env (rechten/inhoud) op de scan-machine.',
    });
  }
}

// ── Scan-gedraaid-check (data-kant; werkt vanaf elke machine) ─────────────────
async function checkScanGedraaid(samenvatting) {
  if (!sb) return null;
  const { data, error } = await sb.from('instellingen').select('value, updated_at')
    .eq('restaurant', 'europizza').eq('key', 'laatste_scan').maybeSingle();
  if (error) {
    gap({
      sleutel: 'supabase|instellingen-onbereikbaar', type: 'connectiviteit', ernst: 'midden', domein: 'scan_gedraaid',
      bron: 'Supabase instellingen (laatste_scan)', bewijs: `query-fout: ${error.message}`,
      details: 'Kan laatste_scan niet lezen — status van de dagelijkse scan is onbekend.',
      actie: 'Controleer Supabase-bereikbaarheid/credentials.',
    });
    return null;
  }
  geslaagdeDomeinen.add('scan_gedraaid');
  const laatste = data?.value ? new Date(data.value) : null;
  samenvatting.laatste_scan = laatste ? laatste.toISOString() : 'onbekend — geen laatste_scan-rij';
  const leeftijdUren = laatste ? uur(NU - laatste) : Infinity;
  if (leeftijdUren > CFG.scanMaxLeeftijdUren) {
    gap({
      sleutel: 'scan|niet-gedraaid', type: 'connectiviteit', ernst: 'hoog', domein: 'scan_gedraaid',
      message_id: null,
      bron: 'Supabase instellingen europizza/laatste_scan',
      bewijs: `laatste_scan = ${laatste ? laatste.toISOString() : 'ontbreekt'} (${laatste ? Math.round(leeftijdUren) + ' uur geleden' : 'nooit gezet'}); drempel ${CFG.scanMaxLeeftijdUren} uur`,
      details: `De dagelijkse 12:00-scan heeft ${laatste ? Math.round(leeftijdUren) + ' uur' : 'nog nooit'} niet gedraaid — machine-uitval is eerste-klas storing.`,
      actie: 'Controleer de scan-iMac (aan? ingelogd? launchd-job geladen?) en draai zo nodig handmatig node scan.js.',
    });
  }
  return laatste;
}

// ── IMAP read-only helpers ────────────────────────────────────────────────────
function imapVerbind(mb) {
  return new Promise((resolve, reject) => {
    const imap = new Imap({ user: mb.user, password: mb.pass, host: mb.host, port: 993, tls: true, tlsOptions: { rejectUnauthorized: false } });
    imap.once('ready', () => resolve(imap));
    imap.once('error', reject);
    imap.connect();
    setTimeout(() => reject(new Error('IMAP connect-timeout (45s)')), 45000).unref?.();
  });
}
function openBoxReadonly(imap, naam) {
  return new Promise((resolve, reject) => imap.openBox(naam, true /* readOnly — nooit schrijvend */, (err, box) => err ? reject(err) : resolve(box)));
}
function zoekSinds(imap, sinds) {
  return new Promise((resolve, reject) => imap.search([['SINCE', sinds]], (err, uids) => err ? reject(err) : resolve(uids || [])));
}
// Headers + BODYSTRUCTURE per bericht — géén body-download, géén markSeen.
function haalKoppen(imap, uids) {
  return new Promise((resolve, reject) => {
    if (!uids.length) return resolve([]);
    const uit = [];
    const f = imap.fetch(uids, { bodies: 'HEADER.FIELDS (MESSAGE-ID FROM SUBJECT DATE)', struct: true, markSeen: false });
    f.on('message', msg => {
      const item = { header: null, struct: null };
      msg.on('body', stream => {
        let buf = '';
        stream.on('data', c => { buf += c.toString('utf8'); });
        stream.once('end', () => { item.header = Imap.parseHeader(buf); });
      });
      msg.once('attributes', attrs => { item.struct = attrs.struct; });
      msg.once('end', () => uit.push(item));
    });
    f.once('error', reject);
    f.once('end', () => resolve(uit));
  });
}
// Bijlagen uit BODYSTRUCTURE: [{ index, bestandsnaam, isPdf, isAfbeelding }].
// De index is de bijlage-index binnen de mail (volgorde in de structuur) — samen met het
// Message-ID de vergelijkings­sleutel op documentniveau (nooit een oplopend volgnummer).
function bijlagenUitStruct(struct) {
  const uit = [];
  const walk = (node) => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== 'object') return;
    const sub = (node.subtype || '').toLowerCase();
    const type = (node.type || '').toLowerCase();
    const naam = node.disposition?.params?.filename || node.params?.name || null;
    const isBijlage = (node.disposition && /attachment/i.test(node.disposition.type || '')) || (!!naam && type !== 'text');
    if (isBijlage) {
      uit.push({
        index: uit.length, bestandsnaam: naam || `(zonder naam, ${type}/${sub})`,
        isPdf: sub === 'pdf' || /\.pdf$/i.test(naam || ''),
        isAfbeelding: type === 'image' || /\.(jpe?g|png|heic|tiff?)$/i.test(naam || ''),
      });
    }
  };
  walk(struct);
  return uit;
}
function afzenderAdres(header) {
  const raw = (header?.from?.[0] || '');
  const m = raw.match(/<([^>]+)>/);
  return (m ? m[1] : raw).toLowerCase().trim();
}
function emailSleutel(messageId, van, onderwerp, datum) {
  // Zelfde sleutel als de pijplijn (imap-scanner.emailKey): message-id, anders from|subject|dag.
  if (messageId) return String(messageId).trim();
  return `${van || '?'}|${onderwerp || '?'}|${datum ? new Date(datum).toISOString().slice(0, 10) : '?'}`;
}

// ── §2 Volledigheid: INBOX + Spam vergelijken met het verwerkt-ledger ─────────
async function checkVolledigheid(laatsteScan, samenvatting) {
  if (!sb) return;
  // Whitelist en ledger — de pijplijn verwerkt alléén whitelisted afzenders, dus dat is ook
  // de vergelijkingsbasis (een niet-gewhiteliste afzender is bewust beleid, geen gat).
  const [{ data: levRows, error: e1 }, { data: verwRows, error: e2 }] = await Promise.all([
    sb.from('leveranciers').select('naam, email').eq('actief', true),
    sb.from('verwerkte_emails').select('email_key, leverancier, onderwerp, email_datum, producten, verwerkt_op')
      .gte('verwerkt_op', new Date(NU - (CFG.kijkvensterDagen + 31) * 86400000).toISOString()),
  ]);
  if (e1 || e2) {
    gap({
      sleutel: 'supabase|ledger-onbereikbaar', type: 'connectiviteit', ernst: 'midden', domein: 'scan_gedraaid',
      bron: 'Supabase leveranciers/verwerkte_emails', bewijs: `query-fout: ${(e1 || e2).message}`,
      details: 'Whitelist of verwerkt-ledger niet leesbaar — volledigheidscheck kon niet draaien.',
      actie: 'Controleer Supabase-bereikbaarheid.',
    });
    return;
  }
  const whitelist = {};
  for (const r of levRows || []) if (r.email) whitelist[r.email.toLowerCase().trim()] = r.naam;
  const ledger = new Set((verwRows || []).map(r => r.email_key));
  samenvatting.whitelist_afzenders = Object.keys(whitelist).length;
  samenvatting.ledger_mails = ledger.size;

  const magOordelen = !!laatsteScan; // zonder laatste_scan-tijd is "gemist vs. wacht op scan" niet te onderscheiden
  const oordeelGrens = laatsteScan ? new Date(laatsteScan.getTime() - CFG.graceUren * 3600000) : null;
  const hoogGrens = laatsteScan ? new Date(laatsteScan.getTime() - CFG.scanMaxLeeftijdUren * 3600000) : null;
  const sinds = new Date(NU - CFG.kijkvensterDagen * 86400000);

  let docsGezien = 0, docsInLedger = 0;
  for (const mb of CFG.mailboxen) {
    const mbDomein = `imap:${mb.user}`;
    let imap;
    try {
      imap = await imapVerbind(mb);
    } catch (e) {
      gap({
        sleutel: `imap|connect|${mb.user}`, type: 'connectiviteit', ernst: 'midden', domein: 'scan_gedraaid',
        bron: `IMAP ${mb.user}@${mb.host}`, bewijs: `wachter-verbinding mislukt: ${e.message}`,
        details: `Mailbox ${mb.user} is voor de wachter onbereikbaar — als dit aanhoudt raakt ook de scan hem kwijt.`,
        actie: 'Controleer IMAP-credentials/host; test met node test-imap.js.',
      });
      continue;
    }
    try {
      // Folderlijst één keer ophalen: INBOX + eventuele Spam/Junk-varianten.
      const dozen = await new Promise((res, rej) => imap.getBoxes((err, b) => err ? rej(err) : res(b)));
      const namen = [];
      const walkDozen = (obj, prefix) => {
        for (const [naam, sub] of Object.entries(obj || {})) {
          const vol = prefix ? `${prefix}${sub.delimiter || '.'}${naam}` : naam;
          namen.push(vol);
          if (sub.children) walkDozen(sub.children, vol);
        }
      };
      walkDozen(dozen, '');
      const spamDozen = namen.filter(n => /spam|junk|ongewenst|bulk/i.test(n));

      // — INBOX: documentniveau vergelijken (Message-ID + bijlage-index) —
      await openBoxReadonly(imap, 'INBOX');
      const uids = await zoekSinds(imap, sinds);
      const berichten = await haalKoppen(imap, uids);
      for (const b of berichten) {
        const van = afzenderAdres(b.header);
        const domein = van.split('@')[1];
        const leverancier = whitelist[van] || (domein && whitelist[domein]);
        if (!leverancier) continue; // niet-gewhitelist = bewust genegeerd door de pijplijn
        const messageId = (b.header?.['message-id']?.[0] || '').trim() || null;
        const onderwerp = b.header?.subject?.[0] || '(zonder onderwerp)';
        const datum = b.header?.date?.[0] ? new Date(b.header.date[0]) : null;
        const sleutel = emailSleutel(messageId, van, onderwerp, datum);
        const bijlagen = bijlagenUitStruct(b.struct);
        const pdfs = bijlagen.filter(a => a.isPdf);
        const afbeeldingen = bijlagen.filter(a => a.isAfbeelding);
        docsGezien += pdfs.length;
        const inLedger = ledger.has(sleutel);
        if (inLedger) { docsInLedger += pdfs.length; }

        // Formaatafwijking: whitelisted afzender stuurt alléén afbeeldingen (geen PDF) —
        // de pijplijn slaat niet-PDF-bijlagen over ("Bijlage overgeslagen — geen PDF"),
        // dus zo'n factuur verdwijnt stil.
        if (!pdfs.length && afbeeldingen.length) {
          gap({
            sleutel: `formaat|${sleutel}`, type: 'parse_mislukt', ernst: 'midden', domein: mbDomein,
            message_id: messageId,
            bron: `${mb.user}/INBOX, Message-ID ${messageId || `(geen — sleutel ${sleutel})`}`,
            bewijs: `BODYSTRUCTURE: ${afbeeldingen.length} afbeelding(en) (${afbeeldingen.map(a => a.bestandsnaam).join(', ')}), 0 PDF's`,
            details: `"${onderwerp}" van ${leverancier}: afbeelding i.p.v. PDF — de pijplijn verwerkt alleen PDF-bijlagen, dit document wordt stil overgeslagen. Parser-confidence: onbekend — parser levert geen score.`,
            actie: 'Handmatig invoeren, of leverancier vragen als PDF te sturen.',
          });
        }

        // Missend: mail met PDF('s) die vóór (laatste_scan − grace) binnenkwam en NIET in het
        // verwerkt-ledger staat — er is dus minstens één scan overheen gegaan zonder resultaat.
        if (magOordelen && pdfs.length && !inLedger && datum && datum <= oordeelGrens) {
          const overleefdeTweeScans = hoogGrens && datum <= hoogGrens;
          for (const p of pdfs) {
            gap({
              sleutel: `missend|${sleutel}|${p.index}`, type: 'missend',
              ernst: overleefdeTweeScans ? 'hoog' : 'midden', domein: mbDomein,
              message_id: messageId,
              bron: `${mb.user}/INBOX, Message-ID ${messageId || `(geen — sleutel ${sleutel})`}, bijlage #${p.index} "${p.bestandsnaam}"`,
              bewijs: `mail-datum ${datum.toISOString()} ≤ laatste_scan−${CFG.graceUren}u (${oordeelGrens.toISOString()}) én email_key ontbreekt in verwerkte_emails`,
              details: `"${onderwerp}" van ${leverancier} (${pdfs.length} PDF-bijlage${pdfs.length > 1 ? 'n' : ''}) is door ${overleefdeTweeScans ? 'minstens twee scans' : 'de laatste scan'} niet opgepikt.`,
              actie: 'Draai node scan.js --reprocess niet zomaar; check eerst scan-log.txt op deze mail (parse-fout = wacht op retry), anders handmatig verwerken.',
            });
          }
        }
      }
      geslaagdeDomeinen.add(mbDomein);

      // — Spam/Junk: whitelisted afzender in spam = pijplijn ziet 'm nooit (leest alleen INBOX) —
      for (const doosNaam of spamDozen) {
        try {
          await openBoxReadonly(imap, doosNaam);
          const spamUids = await zoekSinds(imap, sinds);
          const spamBerichten = await haalKoppen(imap, spamUids);
          for (const b of spamBerichten) {
            const van = afzenderAdres(b.header);
            const domein = van.split('@')[1];
            const leverancier = whitelist[van] || (domein && whitelist[domein]);
            if (!leverancier) continue;
            const messageId = (b.header?.['message-id']?.[0] || '').trim() || null;
            const onderwerp = b.header?.subject?.[0] || '(zonder onderwerp)';
            gap({
              sleutel: `spam|${emailSleutel(messageId, van, onderwerp, b.header?.date?.[0])}`, type: 'missend', ernst: 'hoog', domein: mbDomein,
              message_id: messageId,
              bron: `${mb.user}/${doosNaam}, Message-ID ${messageId || '(geen)'}`,
              bewijs: `whitelisted afzender ${van} (${leverancier}) aangetroffen in folder "${doosNaam}"`,
              details: `"${onderwerp}" van ${leverancier} staat in ${doosNaam} — de pijplijn leest alleen INBOX en zal deze mail nooit zien.`,
              actie: 'Verplaats de mail naar INBOX en/of zet een filter/uitzondering voor deze afzender.',
            });
          }
        } catch { /* spam-folder niet leesbaar → geen oordeel, geen verzonnen gat */ }
      }
    } catch (e) {
      gap({
        sleutel: `imap|lees|${mb.user}`, type: 'connectiviteit', ernst: 'midden', domein: 'scan_gedraaid',
        bron: `IMAP ${mb.user}@${mb.host}`, bewijs: `leesfout tijdens wachter-cyclus: ${e.message}`,
        details: `Mailbox ${mb.user} kon niet (volledig) gelezen worden — volledigheid van deze mailbox is deze cyclus onbekend.`,
        actie: 'Volgende cyclus opnieuw; blijft dit, controleer de IMAP-server.',
      });
    } finally {
      try { imap.end(); } catch {}
    }
  }
  samenvatting.docs_gezien = docsGezien;
  samenvatting.docs_in_ledger_mails = docsInLedger;

  // Mogelijk duplicaat op ledger-niveau. De echte sleutel is leverancier + documentnummer;
  // dat nummer is post-hoc alleen te zien als de leverancier het in het mail-onderwerp zet
  // (inkoop_facturen upsert op factuurnr en overschrijft een tweede document stil — daar is
  // niets meer te tellen). Nummer-token: cijfergroepen met scheidingsteken ("2026-0429") of
  // ≥5 aaneengesloten cijfers — een kaal jaartal ("2026") telt bewust niet als nummer.
  // Bewust géén bedrag-filter (creditnota/correctie met zelfde nummer is juist relevant) en
  // bewust "mogelijk" — nooit hard "duplicaat". Blinde vlek (zie WACHTER.md): duplicaten met
  // een generiek onderwerp zónder nummer zijn hier niet detecteerbaar; die flaggen op
  // onderwerp alleen bleek structurele ruis (leveranciers die wekelijks hetzelfde onderwerp
  // gebruiken) — en een verzonnen gat is erger dan een gedocumenteerde blinde vlek.
  const perNummer = new Map();
  for (const r of verwRows || []) {
    if (!r.leverancier || !r.onderwerp) continue;
    const nummer = (r.onderwerp.match(/\d+(?:[-\/.]\d+)+|\d{5,}/) || [])[0] || null;
    if (!nummer) continue;
    const k = `${r.leverancier}|${nummer}`;
    if (!perNummer.has(k)) perNummer.set(k, []);
    perNummer.get(k).push(r);
  }
  for (const [k, rows] of perNummer) {
    if (rows.length < 2) continue;
    const keys = rows.map(r => r.email_key);
    gap({
      sleutel: `dup|${k}`, type: 'mogelijk_duplicaat', ernst: 'laag', domein: 'ledger',
      message_id: keys[0],
      bron: `verwerkte_emails: ${keys.slice(0, 3).join(' · ')}${keys.length > 3 ? ` (+${keys.length - 3})` : ''}`,
      bewijs: `${rows.length} verschillende mails van "${rows[0].leverancier}" met documentnummer-token "${k.split('|')[1]}" in het onderwerp (bv. "${rows[0].onderwerp}")`,
      details: `Mogelijk duplicaat (of creditnota/correctie — óók relevant, dus niet op bedrag gefilterd): ${rows.length} mails wijzen op hetzelfde documentnummer.`,
      actie: 'Controleer in inkoop_facturen of dit document dubbel of overschreven is (upsert op factuurnr overschrijft stil).',
    });
  }
  geslaagdeDomeinen.add('ledger');
}

// ── §3 Parseerkwaliteit (inkoop_facturen — verplichte velden + drempels) ──────
async function checkParseKwaliteit(samenvatting) {
  if (!sb) return;
  const sinds = new Date(NU - CFG.kijkvensterDagen * 86400000).toISOString();
  const { data, error } = await sb.from('inkoop_facturen')
    .select('factuurnr, leverancier, factuurdatum, totaalbedrag, aangemaakt_op')
    .gte('aangemaakt_op', sinds);
  if (error) {
    gap({
      sleutel: 'supabase|facturen-onbereikbaar', type: 'connectiviteit', ernst: 'midden', domein: 'scan_gedraaid',
      bron: 'Supabase inkoop_facturen', bewijs: `query-fout: ${error.message}`,
      details: 'inkoop_facturen niet leesbaar — parseerkwaliteit kon niet gecontroleerd worden.',
      actie: 'Controleer Supabase-bereikbaarheid.',
    });
    return;
  }
  geslaagdeDomeinen.add('facturen');
  samenvatting.facturen_gecontroleerd = (data || []).length;
  for (const f of data || []) {
    const nr = String(f.factuurnr ?? '').trim();
    const problemen = [];
    // De parser (Claude in imap-scanner) levert géén confidence-score; dat rapporteren we
    // letterlijk zo — nooit een getal verzinnen.
    if (!f.leverancier || !String(f.leverancier).trim()) problemen.push('leverancier ontbreekt');
    if (!nr) problemen.push('documentnummer leeg');
    // eslint-disable-next-line no-control-regex
    if (nr && /[\x00-\x1f\x7f]/.test(nr)) problemen.push('documentnummer bevat controletekens');
    if (!f.factuurdatum) problemen.push('datum ontbreekt');
    if (f.totaalbedrag == null) problemen.push('bedrag ontbreekt');
    // Drempels (opdracht §3). Documenttype kent de pijplijn niet; een creditnota is eerder
    // negatief dan 0, dus bedrag == 0 blijft verdacht maar heet expliciet "mogelijk creditnota".
    if (f.totaalbedrag != null && Number(f.totaalbedrag) === 0) problemen.push('bedrag = €0,00 (documenttype onbekend — mogelijk creditnota, mogelijk parse-fout)');
    if (f.factuurdatum) {
      const d = new Date(f.factuurdatum);
      if (NU - d > CFG.factuurDatumMaxOudDagen * 86400000) problemen.push(`factuurdatum ${f.factuurdatum} is > ${CFG.factuurDatumMaxOudDagen} dagen oud`);
      if (d - NU > CFG.factuurDatumMaxToekomstDagen * 86400000) problemen.push(`factuurdatum ${f.factuurdatum} ligt > ${CFG.factuurDatumMaxToekomstDagen} dagen in de toekomst`);
    }
    if (!problemen.length) continue;
    gap({
      sleutel: `parse|${f.leverancier || '?'}|${nr || '(leeg)'}|${f.aangemaakt_op}`, type: 'parse_mislukt', ernst: 'midden', domein: 'facturen',
      bron: `inkoop_facturen factuurnr="${nr || '(leeg)'}" leverancier="${f.leverancier || '?'}"`,
      bewijs: `rij (aangemaakt ${f.aangemaakt_op}): bedrag=${f.totaalbedrag ?? 'null'}, datum=${f.factuurdatum ?? 'null'}`,
      details: `Verdachte parse-output: ${problemen.join('; ')}. Confidence: onbekend — parser levert geen score.`,
      actie: 'Open de bronfactuur (zoek de mail op leverancier/datum) en corrigeer of herparse.',
    });
  }
}

// ── §4 Stille fouten: nieuw log-segment sinds vorige cyclus doorzoeken ────────
function checkLog(state, samenvatting) {
  let st;
  try { st = fs.statSync(CFG.logPad); } catch {
    samenvatting.log = `onbekend — ${CFG.logPad} bestaat niet op deze machine`;
    return;
  }
  // Alleen zinvol waar de scan zijn log schrijft (scan-machine). Een dagen-oud log elders
  // levert geen oordeel over "de afgelopen cyclus".
  const vorigeOffset = (state.logOffset && state.logOffset <= st.size) ? state.logOffset : 0;
  const nieuw = fs.readFileSync(CFG.logPad, 'utf8').slice(vorigeOffset);
  state.logOffset = st.size;
  if (!nieuw.trim()) { geslaagdeDomeinen.add('log'); samenvatting.log = 'geen nieuwe regels sinds vorige cyclus'; return; }

  const regels = nieuw.split('\n');
  const patronen = [
    // Opgepikt maar geen eindstatus: parse-fout → mail blijft retrybaar = "hangend".
    { re: /PARSE-FOUT|N.ET als verwerkt gemarkeerd|parse-fout, volgende run opnieuw|mail blijft retrybaar/i, type: 'hangend', ernst: 'midden', actie: 'Wacht op retry bij de volgende scan; blijft dit terugkomen, open de PDF handmatig (wachtwoord-beveiligd/corrupt?).' },
    // Infra-fouten die "netjes" zijn afgevangen maar nergens toe leidden.
    { re: /overgeslagen na 3 pogingen|IMAP timeout|IMAP .* mislukt/i, type: 'connectiviteit', ernst: 'midden', actie: 'Controleer de IMAP-verbinding vanaf de scan-machine (node test-imap.js).' },
    { re: /schrijffout|niet opgeslagen|niet geladen|Supabase fout/i, type: 'parse_mislukt', ernst: 'midden', actie: 'Data is mogelijk niet weggeschreven — controleer Supabase en draai de scan opnieuw.' },
    // Overige afgevangen waarschuwingen: stil gelogd is óók onopgemerkt.
    { re: /^\s*.*⚠/, type: 'parse_mislukt', ernst: 'laag', actie: 'Beoordeel de logregel; geen automatische actie.' },
  ];
  let gevonden = 0;
  for (const regel of regels) {
    const r = regel.trim();
    if (!r) continue;
    for (const p of patronen) {
      if (!p.re.test(r)) continue;
      gevonden++;
      gap({
        sleutel: `log|${r.slice(0, 200)}`, type: p.type, ernst: p.ernst, domein: 'log',
        bron: `${CFG.logPad} (segment ${vorigeOffset}–${st.size})`,
        bewijs: r.slice(0, 300),
        details: `Afgevangen fout in scan-log die nergens toe leidde: "${r.slice(0, 160)}"`,
        actie: p.actie,
      });
      break; // eerste passend patroon telt; geen dubbele gaten voor één regel
    }
  }
  geslaagdeDomeinen.add('log');
  samenvatting.log = `${regels.length} nieuwe regels doorzocht, ${gevonden} verdachte`;
}

// ── §0 Dead-man's switch + onderbrekingsdetectie ──────────────────────────────
function checkOnderbreking(state) {
  if (!state.laatsteHeartbeat) return;
  const gatMs = NU - new Date(state.laatsteHeartbeat);
  const verwachtMs = CFG.intervalMin * 60000 * 2.5; // ruime marge boven het interval
  if (gatMs > verwachtMs) {
    const uren = Math.round(uur(gatMs) * 10) / 10;
    gap({
      sleutel: `onderbreking|${state.laatsteHeartbeat}`, type: 'onderbreking_gedetecteerd',
      ernst: uren > 12 ? 'hoog' : 'midden', domein: 'heartbeat_gat',
      bron: `wachter-state ${CFG.statePad} op ${os.hostname()}`,
      bewijs: `vorige heartbeat ${state.laatsteHeartbeat}, nu ${NU.toISOString()} — gat van ${uren} uur bij interval ${CFG.intervalMin} min`,
      details: `De wachter zelf heeft ${uren} uur niet gedraaid (slaap/herstart/uitgezet). Alles in dat venster is onbewaakt geweest.`,
      actie: 'Controleer waarom de wachter-job niet draaide (launchctl list rest.europa.scanwachter) en of het externe dead-man\'s-alarm afging.',
    });
  }
  geslaagdeDomeinen.add('heartbeat_gat');
}
function checkBewakingsConfig() {
  // Domein altijd als gecheckt markeren — óók (juist) wanneer er niets mis is, anders kan
  // een eerder config-gat nooit auto-oplossen zodra de URL's zijn ingevuld.
  geslaagdeDomeinen.add('config');
  const mist = [];
  if (!CFG.heartbeatUrl) mist.push('WACHTER_HEARTBEAT_URL (dead-man\'s switch — HARDE eis: zonder externe ping merkt niemand dat de wachter zelf stilvalt)');
  if (!CFG.alertWebhookUrl && !(CFG.telegramToken && CFG.telegramChat)) mist.push('WACHTER_ALERT_URL óf WACHTER_TELEGRAM_BOT_TOKEN+WACHTER_TELEGRAM_CHAT_ID (escalatiekanaal los van de mailpijplijn)');
  if (!mist.length) return;
  gap({
    sleutel: 'config|bewaking-extern', type: 'connectiviteit', ernst: 'midden', domein: 'config',
    bron: `.env op ${os.hostname()}`,
    bewijs: `ontbrekende env-variabelen: ${mist.map(m => m.split(' ')[0]).join(', ')}`,
    details: `Externe borging onvolledig: ${mist.join('; ')}.`,
    actie: 'Maak een check aan op healthchecks.io (of Uptime Kuma op andere hardware) en/of een webhook, en zet de URL(s) in .env — zie WACHTER.md.',
  });
}

// ── Upsert naar Supabase (idempotent; 'genegeerd' blijft genegeerd) ───────────
async function schrijfGaten() {
  if (!sb) return { open: gaten.size, fout: 'geen Supabase' };
  const ids = [...gaten.keys()];
  const bestaand = new Map();
  if (ids.length) {
    // In brokken van 100 ophalen (lange IN-lijsten vermijden).
    for (let i = 0; i < ids.length; i += 100) {
      const { data } = await sb.from('scan_wachter_gaten').select('gap_id, status, eerste_detectie, retry_teller').in('gap_id', ids.slice(i, i + 100));
      for (const r of data || []) bestaand.set(r.gap_id, r);
    }
  }
  const nuIso = NU.toISOString();
  const rows = [];
  for (const g of gaten.values()) {
    const oud = bestaand.get(g.gap_id);
    if (oud?.status === 'genegeerd') {
      // Mens heeft dit bewust genegeerd: alleen laatst_gezien bijwerken, status blijft.
      rows.push({ ...g, status: 'genegeerd', eerste_detectie: oud.eerste_detectie, laatst_gezien: nuIso, retry_teller: (oud.retry_teller || 0) + 1 });
    } else if (oud) {
      rows.push({ ...g, status: 'open', eerste_detectie: oud.eerste_detectie, laatst_gezien: nuIso, retry_teller: (oud.retry_teller || 0) + 1 });
    } else {
      rows.push({ ...g, status: 'open', eerste_detectie: nuIso, laatst_gezien: nuIso, retry_teller: 0 });
    }
  }
  if (!DRY && rows.length) {
    const { error } = await sb.from('scan_wachter_gaten').upsert(rows, { onConflict: 'gap_id' });
    if (error) return { open: rows.length, fout: error.message };
  }

  // Auto-oplossen: open gaten uit een domein dat deze cyclus volledig gecheckt is en nu
  // niet meer gedetecteerd worden → 'opgelost'. Domeinen die faalden blijven onaangeroerd.
  const opgelost = [];
  if (geslaagdeDomeinen.size) {
    const { data: openGaten } = await sb.from('scan_wachter_gaten').select('gap_id, domein, type, details').eq('status', 'open');
    for (const r of openGaten || []) {
      if (!r.domein || !geslaagdeDomeinen.has(r.domein)) continue;
      if (gaten.has(r.gap_id)) continue;
      opgelost.push(r);
    }
    if (!DRY && opgelost.length) {
      await sb.from('scan_wachter_gaten').update({ status: 'opgelost', laatst_gezien: nuIso, cyclus_id: CYCLUS_ID })
        .in('gap_id', opgelost.map(r => r.gap_id));
    }
  }
  return { rows, opgelost };
}

// ── Escalatie (kanaal los van de mailpijplijn; dedupe max 1×/4u; herstelbericht) ──
async function stuurAlarm(tekst) {
  if (DRY) { log('DRY alarm:', tekst.slice(0, 200)); return true; }
  try {
    if (CFG.telegramToken && CFG.telegramChat) {
      const r = await fetch(`https://api.telegram.org/bot${CFG.telegramToken}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: CFG.telegramChat, text: tekst }),
      });
      return r.ok;
    }
    if (CFG.alertWebhookUrl) {
      const r = await fetch(CFG.alertWebhookUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: tekst }),
      });
      return r.ok;
    }
  } catch (e) { console.error('[wachter] alarm versturen mislukt:', e.message); }
  return false;
}
async function escaleer(state, rows, opgelost) {
  state.alarmen = state.alarmen || {};
  const nuMs = NU.getTime();
  const herhaalMs = CFG.alarmHerhaalUren * 3600000;

  for (const g of rows || []) {
    if (g.status !== 'open') continue;
    const openMin = (nuMs - new Date(g.eerste_detectie).getTime()) / 60000;
    const moet =
      g.ernst === 'hoog' ||
      (g.ernst === 'midden' && openMin >= CFG.middenAlarmNaMin) ||
      (g.type === 'connectiviteit' && openMin >= 2 * CFG.intervalMin);
    if (!moet) continue;
    const vorige = state.alarmen[g.gap_id] ? new Date(state.alarmen[g.gap_id]).getTime() : 0;
    if (nuMs - vorige < herhaalMs) continue; // max 1× per 4 uur, niet per cyclus
    const ok = await stuurAlarm(`⚠ [scan-wachter] ${g.type} (${g.ernst}) — ${g.details}\nBewijs: ${g.bewijs}\nActie: ${g.voorgestelde_actie}`);
    if (ok) state.alarmen[g.gap_id] = NU.toISOString();
  }

  // Herstelbericht voor gaten die eerder een alarm kregen en nu zijn opgelost.
  for (const r of opgelost || []) {
    if (!state.alarmen[r.gap_id]) continue;
    await stuurAlarm(`✅ [scan-wachter] hersteld: ${r.type} — ${String(r.details || '').slice(0, 160)}`);
    delete state.alarmen[r.gap_id];
  }
}

// ── Heartbeat (dead-man's switch, §0) ─────────────────────────────────────────
async function heartbeat(ok, samenvatting) {
  if (!CFG.heartbeatUrl || DRY) return CFG.heartbeatUrl ? 'dry-run' : false;
  try {
    const url = ok ? CFG.heartbeatUrl : `${CFG.heartbeatUrl.replace(/\/$/, '')}/fail`;
    const r = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cyclus_id: CYCLUS_ID, gaten_open: gaten.size, ...samenvatting }),
      timeout: 15000,
    });
    return r.ok;
  } catch (e) { console.error('[wachter] heartbeat mislukt:', e.message); return false; }
}

// ── Hoofdcyclus ───────────────────────────────────────────────────────────────
async function run() {
  log(`cyclus ${CYCLUS_ID}${DRY ? ' [DRY-RUN]' : ''}`);
  const state = leesState();
  const samenvatting = {};
  let cyclusOk = true;

  if (!sb) {
    console.error('[wachter] Supabase niet geconfigureerd — vrijwel alle checks onmogelijk.');
    cyclusOk = false;
  }

  try {
    checkOnderbreking(state);
    checkBewakingsConfig();
    checkMachine(state, samenvatting);
    const laatsteScan = await checkScanGedraaid(samenvatting);
    await checkVolledigheid(laatsteScan, samenvatting);
    await checkParseKwaliteit(samenvatting);
    checkLog(state, samenvatting);
  } catch (e) {
    cyclusOk = false;
    console.error('[wachter] cyclus-fout:', e.message);
    samenvatting.cyclus_fout = e.message;
  }

  const { rows = [], opgelost = [], fout } = await schrijfGaten();
  if (fout) { cyclusOk = false; samenvatting.schrijf_fout = fout; }
  await escaleer(state, rows, opgelost);

  const hbOk = await heartbeat(cyclusOk, samenvatting);
  state.laatsteCyclus = NU.toISOString();
  if (cyclusOk) state.laatsteHeartbeat = NU.toISOString(); // ook zonder externe URL: basis voor onderbrekingsdetectie
  schrijfState(state);

  // Cyclus-record (interne heartbeat-spiegel voor dashboard/externe cron).
  if (sb && !DRY) {
    await sb.from('scan_wachter_cycli').upsert({
      cyclus_id: CYCLUS_ID, gestart: NU.toISOString(), klaar: new Date().toISOString(),
      machine: os.hostname(), is_scanmachine: samenvatting.is_scanmachine ?? null,
      gaten_open: rows.filter(r => r.status === 'open').length,
      heartbeat_ok: hbOk === true, samenvatting,
    }, { onConflict: 'cyclus_id' }).then(({ error }) => { if (error) console.error('[wachter] cyclus-record:', error.message); });
  }

  // Ook bij nul gaten: lege lijst + heartbeat-record — nooit een gat verzinnen om "iets" te melden.
  log(`klaar — ${rows.length} gat(en) gerapporteerd (${rows.filter(r => r.status === 'open').length} open), ${opgelost.length} opgelost, heartbeat=${hbOk}`);
  if (rows.length) for (const g of rows) log(` • [${g.ernst}] ${g.type}: ${g.details.slice(0, 120)}`);
  if (DRY) console.log(JSON.stringify({ cyclus_id: CYCLUS_ID, samenvatting, gaten: rows, opgelost }, null, 2));
}

run().catch(async (e) => {
  console.error('[wachter] fatale fout:', e);
  await heartbeat(false, { fataal: e.message }).catch(() => {});
  process.exit(1);
});
