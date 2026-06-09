/**
 * Leveranciers-onboarding scan: doorzoekt de laatste 30 dagen IMAP en verzamelt
 * unieke afzenders die op leveranciers lijken (factuur/pakbon in onderwerp of
 * body, of een PDF-bijlage) en NIET in de whitelist staan. Schrijft kandidaten
 * naar Supabase `gevonden_afzenders`, waar de Instellingen-pagina ze toont.
 *
 * Gebruik: node src/scan-afzenders.js [--debug]
 * Markeert e-mails NIET als gelezen.
 */
require('dotenv').config();
const ImapScanner = require('./imap-scanner');
const { createClient } = require('@supabase/supabase-js');

const INVOICE_RE = /factuur|faktuur|pakbon|invoice|bestelbon|leverbon|vrachtbrief/i;
// Onderwerpen die geen leveranciersfactuur zijn (aanmaningen, offertes, replies)
const SKIP_SUBJECT_RE = /aanmaning|herinnering|betalingsherinnering|offerte|typefout/i;
// Gratis/persoonlijke e-maildomeinen — vrijwel nooit een goederenleverancier
const PERSOONLIJKE_DOMEINEN = new Set([
  'gmail.com', 'outlook.com', 'outlook.nl', 'hotmail.com', 'hotmail.nl', 'live.nl', 'live.com',
  'icloud.com', 'me.com', 'yahoo.com', 'ziggo.nl', 'kpnmail.nl', 'planet.nl', 'home.nl',
]);

function naamUitAfzender(parsed) {
  const v = parsed.from?.value?.[0] || {};
  if (v.name && v.name.trim() && !v.name.includes('@')) return v.name.trim();
  const domain = (v.address || '').split('@')[1] || (v.address || '');
  const base = (domain.split('.')[0] || domain);
  return base.charAt(0).toUpperCase() + base.slice(1);
}

(async () => {
  const debug = process.argv.includes('--debug');
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) { console.error('[afzenders] Supabase niet geconfigureerd (SUPABASE_URL/SUPABASE_ANON_KEY)'); process.exit(1); }
  const sb = createClient(url, key);

  // Whitelist laden om bekende afzenders uit te sluiten
  const { data: levs, error: levErr } = await sb.from('leveranciers').select('email');
  if (levErr) { console.error('[afzenders] leveranciers niet geladen:', levErr.message); process.exit(1); }
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
  if (boxes.length === 0) { console.error('[afzenders] Geen IMAP-mailbox geconfigureerd'); process.exit(1); }

  console.log(`[afzenders] Scan ${boxes.length} mailbox(en), laatste 30 dagen, whitelist: ${whitelist.size} adressen`);

  const found = {};
  for (const box of boxes) {
    let emails = [];
    try {
      emails = await new ImapScanner(box).fetchEmails({ markSeen: false, lookbackDays: 30, reprocess: true, debug });
    } catch (e) { console.warn(`[afzenders] mailbox ${box.imapUser} fout: ${e.message}`); continue; }

    for (const email of emails) {
      const addr = (email.from?.value?.[0]?.address || '').toLowerCase();
      if (!addr || addr === '(onbekend)' || isKnown(addr)) continue;
      const domain = addr.split('@')[1] || '';
      if (PERSOONLIJKE_DOMEINEN.has(domain)) continue;
      const subject = email.subject || '';
      if (SKIP_SUBJECT_RE.test(subject)) continue;
      // Vereist een echte factuur/pakbon-term (een losse PDF-bijlage is te zwak signaal)
      const looksInvoice = INVOICE_RE.test(subject) || INVOICE_RE.test(email.text || '');
      if (!looksInvoice) continue;
      if (!found[addr]) found[addr] = { naam: naamUitAfzender(email), laatste_onderwerp: subject.slice(0, 140), aantal: 0 };
      found[addr].aantal++;
    }
  }

  const rows = Object.entries(found).map(([email, v]) => ({
    email, naam: v.naam, laatste_onderwerp: v.laatste_onderwerp, aantal: v.aantal, gezien_op: new Date().toISOString(),
  }));

  console.log(`\n[afzenders] ${rows.length} kandidaat-afzender(s) gevonden (niet in whitelist):`);
  rows.forEach(r => console.log(`  • ${r.naam} <${r.email}>  (${r.aantal}×)  "${r.laatste_onderwerp}"`));

  if (rows.length) {
    const { error } = await sb.from('gevonden_afzenders').upsert(rows, { onConflict: 'email' });
    if (error) console.error('[afzenders] Supabase schrijffout:', error.message);
    else console.log('\n[afzenders] Opgeslagen in gevonden_afzenders — zichtbaar in Instellingen → Scan inbox.');
  }
})().catch(e => { console.error('[afzenders] Fout:', e.message); process.exit(1); });
