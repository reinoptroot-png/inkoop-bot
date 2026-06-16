// Voer SQL rechtstreeks tegen de Supabase-database uit — geen geplak meer in de SQL-editor.
//
// EENMALIG instellen:
//   Supabase → Project → Settings → Database → "Connection string" → URI (kies de pooler, poort 6543,
//   of de directe verbinding 5432). Plak die in .env als:
//     SUPABASE_DB_URL=postgresql://postgres.<ref>:<wachtwoord>@aws-...supabase.com:6543/postgres
//
// GEBRUIK:
//   node scripts/db.js supabase/goedkeuring-archief.sql        # voer een .sql-bestand uit
//   node concept-merge-voorstellen.js --sql | node scripts/db.js -   # of: pipe gegenereerde SQL via "-"
//
// Werkt voor DDL (alter/create) én data (insert/update/delete). Meerdere statements in één bestand
// mogen — ze draaien in één transactie: faalt er één, dan rolt alles terug (veilig).

require('dotenv').config();
const fs = require('fs');
const { Client } = require('pg');

const url = process.env.SUPABASE_DB_URL;
if (!url) {
  console.error('Zet eerst SUPABASE_DB_URL in .env (Supabase → Settings → Database → Connection string → URI).');
  process.exit(1);
}
const arg = process.argv[2];
if (!arg) {
  console.error('Gebruik: node scripts/db.js <bestand.sql>   (of "-" om SQL van stdin te lezen)');
  process.exit(1);
}

const sql = (arg === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(arg, 'utf8')).trim();
if (!sql) { console.error('Geen SQL gevonden.'); process.exit(1); }

(async () => {
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  try {
    await client.connect();
    await client.query('begin');
    const res = await client.query(sql);              // simple-query: meerdere ;-statements toegestaan
    await client.query('commit');
    const n = Array.isArray(res) ? res.length : 1;
    console.log(`✓ ${n} statement(s) uitgevoerd${arg === '-' ? '' : ' uit ' + arg}.`);
  } catch (e) {
    try { await client.query('rollback'); } catch {}
    console.error('✗ SQL-fout (alles teruggedraaid):', e.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
})();
