/**
 * Inbox overzicht: doorzoekt ALLE geconfigureerde IMAP-mailboxen van de laatste
 * 7 dagen en verzamelt elke unieke afzender met het aantal e-mails, of het adres
 * al in de leveranciers-whitelist staat, en of het food-gerelateerd lijkt.
 * Schrijft het volledige overzicht naar Supabase `inbox_overzicht`, waar de
 * Instellingen-pagina het toont. Verwerkt GEEN e-mails en markeert niets als gelezen.
 *
 * Gebruik: node src/inbox-overzicht.js [--debug]
 */
require('dotenv').config();
const ImapScanner = require('./imap-scanner');
const { lijktFoodLeverancier, afzenderNaam } = ImapScanner;
const { createClient } = require('@supabase/supabase-js');

(async () => {
  const debug = process.argv.includes('--debug');
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) { console.error('[inbox] Supabase niet geconfigureerd (SUPABASE_URL/SUPABASE_ANON_KEY)'); process.exit(1); }
  const sb = createClient(url, key);

  // Whitelist laden om per afzender te bepalen of die al bekend is
  const { data: levs, error: levErr } = await sb.from('leveranciers').select('email');
  if (levErr) { console.error('[inbox] leveranciers niet geladen:', levErr.message); process.exit(1); }
  const whitelist = new Set((levs || []).map(l => (l.email || '').toLowerCase().trim()).filter(Boolean));
  const isKnown = (addr) => {
    const e = (addr || '').toLowerCase();
    const domain = e.split('@')[1] || '';
    for (const w of whitelist) {
      if (e === w || domain === w || e.endsWith('@' + w) || (domain && domain.endsWith(w))) return true;
    }
    return false;
  };

  const base = { imapHost: process.env.IMAP_HOST || 'imap.one.com' };
  const boxes = [];
  if (process.env.IMAP_USER && process.env.IMAP_PASS)   boxes.push({ ...base, imapUser: process.env.IMAP_USER,  imapPass: process.env.IMAP_PASS });
  if (process.env.IMAP_USER2 && process.env.IMAP_PASS2) boxes.push({ ...base, imapUser: process.env.IMAP_USER2, imapPass: process.env.IMAP_PASS2 });
  if (process.env.IMAP_USER3 && process.env.IMAP_PASS3) boxes.push({ ...base, imapUser: process.env.IMAP_USER3, imapPass: process.env.IMAP_PASS3 });
  if (boxes.length === 0) { console.error('[inbox] Geen IMAP-mailbox geconfigureerd'); process.exit(1); }

  console.log(`[inbox] Scan ${boxes.length} mailbox(en), laatste 7 dagen, whitelist: ${whitelist.size} adressen`);

  const found = {};
  for (const box of boxes) {
    let emails = [];
    try {
      emails = await new ImapScanner(box).fetchEmails({ markSeen: false, lookbackDays: 7, reprocess: true, debug });
    } catch (e) { console.warn(`[inbox] mailbox ${box.imapUser} fout: ${e.message}`); continue; }

    for (const email of emails) {
      const addr = (email.from?.value?.[0]?.address || '').toLowerCase();
      if (!addr || addr === '(onbekend)') continue;
      if (!found[addr]) found[addr] = { naam: afzenderNaam(email), laatste_onderwerp: (email.subject || '').slice(0, 140), aantal: 0, food: false };
      found[addr].aantal++;
      if (lijktFoodLeverancier(email)) found[addr].food = true; // food als minstens één mail erop lijkt
    }
  }

  const rows = Object.entries(found).map(([email, v]) => ({
    email,
    naam: v.naam,
    aantal: v.aantal,
    food: v.food,
    in_whitelist: isKnown(email),
    laatste_onderwerp: v.laatste_onderwerp,
    gezien_op: new Date().toISOString(),
  })).sort((a, b) => b.aantal - a.aantal);

  console.log(`\n[inbox] ${rows.length} unieke afzender(s):`);
  rows.forEach(r => console.log(`  • ${r.naam} <${r.email}>  ${r.aantal}×  ${r.in_whitelist ? '[whitelist] ' : ''}${r.food ? '[food]' : ''}`));

  // Vervang de volledige tabel — we tonen alleen de laatste 7 dagen.
  const { error: delErr } = await sb.from('inbox_overzicht').delete().neq('email', '');
  if (delErr) { console.error('[inbox] kon oude rijen niet wissen:', delErr.message); }
  if (rows.length) {
    const { error } = await sb.from('inbox_overzicht').insert(rows);
    if (error) console.error('[inbox] Supabase schrijffout:', error.message);
    else console.log('\n[inbox] Opgeslagen in inbox_overzicht — zichtbaar in Instellingen → Inbox overzicht.');
  }
})().catch(e => { console.error('[inbox] Fout:', e.message); process.exit(1); });
