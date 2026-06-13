// Dry-run: scant recente facturen, berekent de inkoop_facturen-rijen en print ze.
// Schrijft NIETS naar Notion of Supabase. Gebruik: node dry-run-facturen.js [dagen]
require('dotenv').config();
const fs = require('fs');
const ImapScanner = require('./src/imap-scanner');

const sf = (() => { try { return JSON.parse(fs.readFileSync('settings.json', 'utf8')); } catch { return {}; } })();
const g = (env, key) => process.env[env] || sf[key];
const base = {
  imapHost: g('IMAP_HOST', 'imapHost') || 'imap.one.com',
  imapPort: g('IMAP_PORT', 'imapPort') || '993',
  anthropicKey: g('ANTHROPIC_KEY', 'anthropicKey'),
};
const boxes = [];
if (g('IMAP_USER', 'imapUser'))  boxes.push({ ...base, imapUser: g('IMAP_USER', 'imapUser'),  imapPass: g('IMAP_PASS', 'imapPass') });
if (g('IMAP_USER2', 'imapUser2')) boxes.push({ ...base, imapUser: g('IMAP_USER2', 'imapUser2'), imapPass: g('IMAP_PASS2', 'imapPass2') });

const dagen = parseInt(process.argv[2] || '30', 10);
(async () => {
  const alle = [];
  for (const box of boxes) {
    try {
      const sc = new ImapScanner(box);
      await sc.scan({ markSeen: false, lookbackDays: dagen, reprocess: true, debug: false });
      (sc.facturen || []).forEach(f => alle.push(f));
      console.log(`[dry-run] ${box.imapUser}: ${(sc.facturen || []).length} factuur(totalen)`);
    } catch (e) { console.warn(`[dry-run] ${box.imapUser} fout: ${e.message}`); }
  }
  console.log(`\n=== inkoop_facturen — ${alle.length} berekende rij(en), laatste ${dagen} dagen ===`);
  alle.sort((a, b) => String(b.factuurdatum).localeCompare(String(a.factuurdatum)))
      .slice(0, 8).forEach(r => console.log(JSON.stringify(r)));
})().catch(e => { console.error('Fout:', e.message); process.exit(1); });
