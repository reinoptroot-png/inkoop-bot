// Tebi dagrapport integratie voor Restaurant Europa.
// Endpoint: GET https://live.tebi.co/api/insights/ledgers/976290/insights/day-overview?date=YYYY-MM-DD
// Auth: TEBI_SESSION_TOKEN als Cookie-header (browser-sessie token uit Tebi-portal).

const https = require('https');
const LEDGER_ID = process.env.TEBI_LEDGER_ID || '976290';
const BASE = `https://live.tebi.co/api/insights/ledgers/${LEDGER_ID}/insights/day-overview`;

function fetchTebiDayOverview(date, sessionToken) {
  return new Promise((resolve, reject) => {
    const url = `${BASE}?date=${date}`;
    const opts = {
      method: 'GET',
      headers: {
        'Cookie': `session=${sessionToken}`,
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 inkoop-bot',
      },
    };
    const req = https.request(url, opts, (res) => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => {
        if (res.statusCode === 401 || res.statusCode === 403) {
          return reject(new Error(`Tebi auth mislukt (${res.statusCode}) — controleer TEBI_SESSION_TOKEN`));
        }
        if (res.statusCode === 404) {
          return resolve(null); // geen data voor deze datum (bijv. gesloten)
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`Tebi HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        }
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`Tebi JSON parse fout: ${e.message} — body: ${body.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// Haal een getal op uit een object via een lijst van mogelijke sleutels (eerste treffer).
function pick(obj, ...keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of keys) {
    if (obj[k] != null) {
      const v = parseFloat(String(obj[k]).replace(',', '.'));
      return isNaN(v) ? null : v;
    }
  }
  return null;
}

// Zet een Tebi day-overview response om naar het dagrapport-formaat van de
// Supabase `dagrapport`-tabel (zelfde structuur als Lightspeed).
function parseTebiDayOverview(data, datum) {
  if (!data) return null;

  // Tebi stuurt de data doorgaans in een genest object; meerdere mogelijke
  // structuren worden hieronder geprobeerd (generiek → specifiek).
  const root = data.data || data.overview || data.dayOverview || data;

  // Omzetten: top-level totaal
  const totale_omzet = pick(root,
    'totalRevenue', 'total_revenue', 'totalIncome', 'omzet', 'revenue', 'gross');

  // Bar/drank (optioneel — Tebi splitst misschien niet altijd)
  const barSection = root.bar || root.drinks || root.beverage || root.dranken || null;
  const bar_omzet = barSection
    ? pick(barSection, 'totalRevenue', 'total_revenue', 'revenue', 'total')
    : pick(root, 'barRevenue', 'bar_revenue', 'drankenOmzet', 'beverageRevenue');

  // Keuken/food
  const kitchenSection = root.kitchen || root.food || root.keuken || null;
  const keuken_omzet = kitchenSection
    ? pick(kitchenSection, 'totalRevenue', 'total_revenue', 'revenue', 'total')
    : pick(root, 'kitchenRevenue', 'kitchen_revenue', 'keukenOmzet', 'foodRevenue');

  // Gasten en tafels
  const aantal_gasten = pick(root,
    'guestCount', 'guest_count', 'covers', 'couverts', 'customers', 'gasten', 'numberOfGuests');
  const aantal_tafels = pick(root,
    'tableCount', 'table_count', 'tables', 'tafels', 'numberOfTables');

  // Gerechten — probeer meerdere mogelijke array-sleutels
  const rawItems = root.items || root.products || root.dishes ||
    root.menuItems || root.orderLines || root.categories?.flatMap?.(c => c.items || []) || [];

  const gerechten = (Array.isArray(rawItems) ? rawItems : [])
    .map(item => {
      const naam = String(item.name || item.naam || item.productName || item.title || '').trim();
      if (!naam) return null;
      const aantal = pick(item, 'quantity', 'count', 'aantal', 'qty', 'sold');
      const prijs  = pick(item, 'price', 'unitPrice', 'unit_price', 'prijs');
      const totaal = pick(item, 'total', 'totalRevenue', 'total_revenue', 'totaal', 'revenue');
      const categorie = String(item.category || item.categoryName || item.categorie || '').trim();
      const type = String(item.categoryType || item.category_type || item.type || '').trim();
      return {
        naam,
        aantal: aantal ?? null,
        prijs:  prijs  ?? null,
        totaal: totaal ?? null,
        categorie,
        type,
        food: /keuken|kitchen|food/i.test(type) || !/bar|drank|drink|beverage|wijn|bier|wine|beer/i.test(type),
      };
    })
    .filter(Boolean);

  return { datum, totale_omzet, bar_omzet, keuken_omzet, aantal_gasten, aantal_tafels, gerechten };
}

module.exports = { fetchTebiDayOverview, parseTebiDayOverview };
