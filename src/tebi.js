// Tebi dagrapport integratie voor Restaurant Europa.
// Endpoint: GET https://live.tebi.co/api/insights/ledgers/976290/insights/day-overview?date=YYYY-MM-DD
// Auth: Authorization: Bearer <JWT> (ophalen via DevTools → Network → XHR → Authorization header).
// Token sla op als tebiToken in settings.json of env var TEBI_TOKEN.
//
// Werkelijke response-structuur (gedocumenteerd via live test 2026-06-12):
//   metadata.date, metadata.totalCovers (gasten), revenue.salesCount (tafels)
//   summary.totalSales.quantity (bruto omzet incl BTW)
//   revenue.revenuePerCategory[].{ category, grossAmount.quantity }
//     → "Food Europa" = keuken; rest = bar/drank
//   Geen per-gerecht data in dit endpoint — gerechten bevat categorie-totalen.

const https = require('https');
const LEDGER_ID = process.env.TEBI_LEDGER_ID || '976290';
const BASE = `https://live.tebi.co/api/insights/ledgers/${LEDGER_ID}/insights/day-overview`;

function fetchTebiDayOverview(date, token) {
  return new Promise((resolve, reject) => {
    const url = `${BASE}?date=${date}`;
    const req = https.request(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 inkoop-bot',
      },
    }, (res) => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => {
        if (res.statusCode === 401 || res.statusCode === 403) {
          return reject(new Error(`Tebi auth mislukt (${res.statusCode}) — ververs tebiToken in settings.json`));
        }
        if (res.statusCode === 404) return resolve(null); // geen data (gesloten dag)
        if (res.statusCode !== 200) {
          return reject(new Error(`Tebi HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        }
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`Tebi JSON parse fout: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function qty(obj) {
  // Haal numerieke waarde op uit { currency, quantity } object of direct getal.
  if (obj == null) return null;
  if (typeof obj === 'number') return obj;
  const v = parseFloat(obj.quantity ?? obj);
  return isNaN(v) ? null : v;
}

// Zet de Tebi day-overview response om naar het dagrapport-formaat van Supabase.
function parseTebiDayOverview(data, datum) {
  if (!data) return null;

  // Gasten en tafels
  const aantal_gasten = data.metadata?.totalCovers ?? null;
  const aantal_tafels = data.revenue?.salesCount ?? null;

  // Totale bruto omzet (incl BTW, excl fooien/prepayments)
  const totale_omzet = qty(data.summary?.totalSales) ?? qty(data.revenue?.totalGrossAmount);

  // Omzet per categorie — "Food Europa" = keuken, rest = bar/drank
  const cats = data.revenue?.revenuePerCategory || [];
  const foodCats = cats.filter(c => /food/i.test(c.category || ''));
  const barCats  = cats.filter(c => !/food/i.test(c.category || ''));

  const keuken_omzet = foodCats.reduce((s, c) => s + (qty(c.grossAmount) ?? 0), 0) || null;
  const bar_omzet    = barCats.reduce((s, c)  => s + (qty(c.grossAmount) ?? 0), 0) || null;

  // Gerechten: categorie-totalen (dit endpoint geeft geen per-gerecht data).
  // Elke categorie = één rij, zodat het Dashboard de uitsplitsing kan tonen.
  const gerechten = cats
    .filter(c => (c.category || '').trim() && qty(c.grossAmount) > 0)
    .map(c => ({
      naam:      (c.category || '').trim(),
      aantal:    null,
      prijs:     null,
      totaal:    qty(c.grossAmount),
      categorie: (c.category || '').trim(),
      type:      /food/i.test(c.category || '') ? 'Keuken' : 'Bar',
      food:      /food/i.test(c.category || ''),
    }));

  return { datum, totale_omzet, bar_omzet, keuken_omzet, aantal_gasten, aantal_tafels, gerechten };
}

module.exports = { fetchTebiDayOverview, parseTebiDayOverview };
