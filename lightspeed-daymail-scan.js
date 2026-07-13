#!/usr/bin/env node
// Dagelijkse Lightspeed-omzetscan — het gratis alternatief voor de betaalde K-Series API.
// Lightspeed mailt elke ochtend 04:00 een "day report" naar facturen@europizza.rest (dezelfde
// mailbox die de facturen-scan al leest). Dit script haalt de CSV-link uit die mail, downloadt
// en parset 'm (src/lightspeed-daymail.js) en upsert naar Supabase `dagrapport`.
// Dedup via verwerkte_emails (message-id) — zelfde patroon als de facturen-scan, dus nooit
// dubbel verwerkt ook al blijft de mail ongelezen in de inbox staan.
//
//   node lightspeed-daymail-scan.js            # normale run
//   node lightspeed-daymail-scan.js --dry-run  # niet naar Supabase schrijven
//   node lightspeed-daymail-scan.js --reprocess # negeer dedup, verwerk opnieuw
require('dotenv').config({ path: __dirname + '/.env', quiet: true });
const fs = require('fs');
const path = require('path');
const Imap = require('imap');
const { simpleParser } = require('mailparser');
const { createClient } = require('@supabase/supabase-js');
const { extractDayMailCsvUrl, parseDayMailCsv, downloadCsv } = require('./src/lightspeed-daymail');

let _sf = {};
try { _sf = JSON.parse(fs.readFileSync(path.join(__dirname, 'settings.json'), 'utf8')); } catch {}
const cfg = {
  host: process.env.IMAP_HOST || _sf.imapHost || 'imap.one.com',
  user: process.env.IMAP_USER || _sf.imapUser,
  pass: process.env.IMAP_PASS || _sf.imapPass,
  supabaseUrl: process.env.SUPABASE_URL || _sf.supabaseUrl,
  supabaseKey: process.env.SUPABASE_KEY || _sf.supabaseKey,
};
if (!cfg.user || !cfg.pass) throw new Error('IMAP_USER/IMAP_PASS ontbreken (.env of settings.json)');
if (!cfg.supabaseUrl || !cfg.supabaseKey) throw new Error('SUPABASE_URL/SUPABASE_KEY ontbreken');

const sb = createClient(cfg.supabaseUrl, cfg.supabaseKey);
const DRY = process.argv.includes('--dry-run');
const REPROCESS = process.argv.includes('--reprocess');
const EMAIL_KEY_PREFIX = 'lightspeed-daymail:'; // eigen namespace binnen verwerkte_emails

function fetchMailboxMessages() {
  return new Promise((resolve, reject) => {
    const im = new Imap({ user: cfg.user, password: cfg.pass, host: cfg.host, port: 993, tls: true, tlsOptions: { servername: cfg.host }, authTimeout: 15000, connTimeout: 15000 });
    const berichten = [];
    im.once('error', reject);
    im.once('ready', () => im.openBox('INBOX', true, (e) => {
      if (e) return reject(e);
      const sinds = new Date(Date.now() - 30 * 864e5); // 30 dagen lookback, ruim genoeg
      im.search([['HEADER', 'SUBJECT', 'Lightspeed Restaurant day report'], ['SINCE', sinds]], (e2, uids) => {
        if (e2) return reject(e2);
        if (!uids.length) { im.end(); return resolve([]); }
        const f = im.fetch(uids, { bodies: '' });
        let pending = uids.length;
        f.on('message', msg => {
          let buf = '';
          msg.on('body', s => s.on('data', c => buf += c.toString('utf8')));
          msg.once('end', async () => {
            try {
              const parsed = await simpleParser(buf);
              berichten.push({ messageId: parsed.messageId, date: parsed.date, html: parsed.html || parsed.textAsHtml || '', subject: parsed.subject });
            } catch (e3) { console.warn('[ls-daymail] parse-fout:', e3.message); }
            if (--pending === 0) { im.end(); resolve(berichten); }
          });
        });
        f.once('error', reject);
      });
    }));
    im.connect();
  });
}

async function reedsVerwerkt(emailKey) {
  if (REPROCESS) return false;
  const { data } = await sb.from('verwerkte_emails').select('email_key').eq('email_key', emailKey).maybeSingle();
  return !!data;
}
async function markeerVerwerkt(emailKey) {
  await sb.from('verwerkte_emails').upsert({ email_key: emailKey, verwerkt_op: new Date().toISOString() }, { onConflict: 'email_key' });
}

(async () => {
  console.log(`\n=== Lightspeed dag-mail scan — ${new Date().toISOString()} ===`);
  const berichten = await fetchMailboxMessages();
  console.log(`[ls-daymail] ${berichten.length} dagrapport-mail(s) gevonden in facturen@europizza.rest`);

  let ok = 0, overgeslagen = 0, fout = 0;
  for (const b of berichten) {
    const emailKey = `${EMAIL_KEY_PREFIX}${b.messageId || b.subject}`;
    if (await reedsVerwerkt(emailKey)) { overgeslagen++; continue; }
    try {
      const url = extractDayMailCsvUrl(b.html);
      if (!url) throw new Error('geen CSV-link gevonden in mail');
      const csv = await downloadCsv(url);
      const dr = parseDayMailCsv(csv);
      if (!dr.datum) throw new Error('geen datum in CSV');
      if (!DRY) {
        const { error } = await sb.from('dagrapport').upsert({
          datum: dr.datum, restaurant: 'europizza',
          totale_omzet: dr.totale_omzet, bar_omzet: dr.bar_omzet, keuken_omzet: dr.keuken_omzet,
          aantal_gasten: dr.aantal_gasten, aantal_tafels: dr.aantal_tafels, gerechten: dr.gerechten,
        }, { onConflict: 'datum,restaurant' });
        if (error) throw new Error(`Supabase: ${error.message}`);
        await markeerVerwerkt(emailKey);
      }
      console.log(`  ✓ ${dr.datum} — €${dr.totale_omzet} excl (keuken €${dr.keuken_omzet} / bar €${dr.bar_omzet}) · ${dr.aantal_gasten} gasten · ${dr.gerechten.length} producten`);
      ok++;
    } catch (e) {
      console.warn(`  ✗ "${b.subject}": ${e.message}`);
      fout++;
    }
  }
  console.log(`\n${ok} nieuw verwerkt · ${overgeslagen} al bekend · ${fout} mislukt`);
  try {
    fs.appendFileSync(path.join(__dirname, 'lightspeed-daymail-log.txt'),
      `${new Date().toISOString()} — ${ok} nieuw, ${overgeslagen} bekend, ${fout} mislukt\n`);
  } catch {}
})().catch(e => { console.error('[ls-daymail] FATAL:', e.message); process.exit(1); });
