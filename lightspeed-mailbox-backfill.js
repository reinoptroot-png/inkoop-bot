#!/usr/bin/env node
// Herparseert alle Lightspeed dagrapport-mails in de mailbox met de HUIDIGE src/lightspeed.js
// (parseDagrapport/extractCsvLink) en upsert ze naar Supabase `dagrapport`. Los van de dagelijkse
// scan.js-flow (die alleen NIEUWE mails oppikt) — dit script is voor als de parser ooit verbetert
// en de al-opgeslagen dagen opnieuw moeten worden doorgerekend met de nieuwe logica.
//
//   node lightspeed-mailbox-backfill.js            # normale run
//   node lightspeed-mailbox-backfill.js --dry-run  # niet naar Supabase schrijven
require('dotenv').config({ path: __dirname + '/.env', quiet: true });
const fs = require('fs');
const path = require('path');
const Imap = require('imap');
const { simpleParser } = require('mailparser');
const { createClient } = require('@supabase/supabase-js');
const { isLightspeedDagrapport, extractCsvLink, parseDagrapport } = require('./src/lightspeed');

let _sf = {};
try { _sf = JSON.parse(fs.readFileSync(path.join(__dirname, 'settings.json'), 'utf8')); } catch {}
const cfg = {
  host: process.env.IMAP_HOST || _sf.imapHost || 'imap.one.com',
  user: process.env.IMAP_USER || _sf.imapUser,
  pass: process.env.IMAP_PASS || _sf.imapPass,
  supabaseUrl: process.env.SUPABASE_URL || _sf.supabaseUrl,
  supabaseKey: process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || _sf.supabaseKey,
};
const sb = createClient(cfg.supabaseUrl, cfg.supabaseKey);
const DRY = process.argv.includes('--dry-run');

function fetchMessages() {
  return new Promise((resolve, reject) => {
    const im = new Imap({ user: cfg.user, password: cfg.pass, host: cfg.host, port: 993, tls: true, tlsOptions: { servername: cfg.host }, authTimeout: 15000, connTimeout: 15000 });
    const berichten = [];
    im.once('error', reject);
    im.once('ready', () => im.openBox('INBOX', true, (e) => {
      if (e) return reject(e);
      im.search([['HEADER', 'SUBJECT', 'Lightspeed Restaurant day report'], ['SINCE', new Date(Date.now() - 60 * 864e5)]], (e2, uids) => {
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
              berichten.push({ subject: parsed.subject, date: parsed.date, html: parsed.html || '', text: parsed.text || '' });
            } catch (e3) { console.warn('[backfill] parse-fout:', e3.message); }
            if (--pending === 0) { im.end(); resolve(berichten); }
          });
        });
        f.once('error', reject);
      });
    }));
    im.connect();
  });
}

(async () => {
  console.log(`=== Lightspeed mailbox-backfill (${DRY ? 'dry-run' : 'schrijft naar Supabase'}) ===`);
  const berichten = await fetchMessages();
  console.log(`${berichten.length} dagrapport-mail(s) gevonden\n`);

  let ok = 0, fout = 0;
  for (const b of berichten) {
    const email = { html: b.html, text: b.text, subject: b.subject, from: { value: [{ address: 'no.reply@backend-mailing.lightspeedrestaurant.com' }] } };
    if (!isLightspeedDagrapport(email)) { console.warn(`  ✗ "${b.subject}": geen CSV-link herkend`); fout++; continue; }
    try {
      const url = extractCsvLink(email);
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const csv = await resp.text();
      const dr = parseDagrapport(csv);
      if (!dr.datum) throw new Error('geen datum in CSV');
      if (!DRY) {
        const { error } = await sb.from('dagrapport').upsert({
          datum: dr.datum, restaurant: 'europizza',
          totale_omzet: dr.totale_omzet, bar_omzet: dr.bar_omzet, keuken_omzet: dr.keuken_omzet,
          aantal_gasten: dr.aantal_gasten, aantal_tafels: dr.aantal_tafels, gerechten: dr.gerechten,
        }, { onConflict: 'datum,restaurant' });
        if (error) throw new Error(`Supabase: ${error.message}`);
      }
      console.log(`  ✓ ${dr.datum} — €${dr.totale_omzet} · keuken €${dr.keuken_omzet} · bar €${dr.bar_omzet} · ${dr.gerechten.length} gerechten`);
      ok++;
    } catch (e) {
      console.warn(`  ✗ "${b.subject}": ${e.message}`);
      fout++;
    }
  }
  console.log(`\n${ok} bijgewerkt · ${fout} mislukt`);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
