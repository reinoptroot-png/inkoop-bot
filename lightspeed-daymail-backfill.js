// Backfill dagrapporten uit de Lightspeed dag-mail CSV-links (het gratis API-alternatief).
// Input: een JSON-bestand met [{ datum: "YYYY-MM-DD", url: "https://…csv=1" }, …]
// (de tokenized links uit de "day report"-mails). Downloadt elke CSV, parset 'm met
// src/lightspeed-daymail.js en upsert naar Supabase `dagrapport` (restaurant=europizza).
//
//   node lightspeed-daymail-backfill.js links.json [--dry-run]
require('dotenv').config({ path: __dirname + '/.env', quiet: true });
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
const { parseDayMailCsv, downloadCsv } = require('./src/lightspeed-daymail');

const bestand = process.argv[2];
const DRY = process.argv.includes('--dry-run');
if (!bestand) { console.error('Gebruik: node lightspeed-daymail-backfill.js links.json'); process.exit(1); }

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

(async () => {
  const links = JSON.parse(fs.readFileSync(bestand, 'utf8'));
  console.log(`${links.length} dagrapport-links (${DRY ? 'dry-run' : 'schrijven naar Supabase'})`);
  let ok = 0, fout = 0;
  for (const { datum, url } of links) {
    try {
      const csv = await downloadCsv(url);
      const dr = parseDayMailCsv(csv);
      if (!dr.datum) throw new Error('geen datum in CSV');
      if (datum && dr.datum !== datum) console.warn(`  ⚠ ${datum}: CSV zegt ${dr.datum} — CSV-datum aangehouden`);
      if (!DRY) {
        const { error } = await sb.from('dagrapport').upsert({
          datum: dr.datum, restaurant: 'europizza',
          totale_omzet: dr.totale_omzet, bar_omzet: dr.bar_omzet, keuken_omzet: dr.keuken_omzet,
          aantal_gasten: dr.aantal_gasten, aantal_tafels: dr.aantal_tafels, gerechten: dr.gerechten,
        }, { onConflict: 'datum,restaurant' });
        if (error) throw new Error(error.message);
      }
      console.log(`  ✓ ${dr.datum} — €${dr.totale_omzet} excl (keuken €${dr.keuken_omzet} / bar €${dr.bar_omzet}) · ${dr.aantal_gasten} gasten · ${dr.gerechten.length} producten`);
      ok++;
    } catch (e) {
      console.log(`  ✗ ${datum}: ${e.message}`);
      fout++;
    }
    await new Promise(r => setTimeout(r, 400));
  }
  console.log(`\n${ok} dagen geladen · ${fout} mislukt`);
})();
