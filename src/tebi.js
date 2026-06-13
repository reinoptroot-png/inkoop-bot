// Tebi dagrapport integratie voor Restaurant Europa.
// Endpoint: GET https://live.tebi.co/api/insights/ledgers/976290/insights/day-overview?date=YYYY-MM-DD
//
// Auth: Auth0 PKCE flow. Eenmalig: node tebi-setup.js → slaat refresh_token op.
// Daarna: refreshTebiToken() haalt automatisch een verse access_token op.
//
// Response-structuur (gedocumenteerd via live test 2026-06-12):
//   metadata.totalCovers → aantal_gasten
//   revenue.salesCount   → aantal_tafels
//   summary.totalSales   → totale_omzet (bruto incl BTW)
//   revenue.revenuePerCategory[] → keuken (Food Europa) + bar (rest)
//   Geen per-gerecht data — gerechten = categorie-totalen.

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const CLIENT_ID   = '0tGlVnSFHtEZwttnrsKKFzomyq9AWlyQ';
const AUTH_DOMAIN = 'auth.tebi.co';
const LEDGER_ID   = process.env.TEBI_LEDGER_ID || '976290';
const BASE        = `https://live.tebi.co/api/insights/ledgers/${LEDGER_ID}/insights/day-overview`;
const SETTINGS    = path.join(__dirname, '..', 'settings.json');

function postJson(hostname, p, body) {
  return new Promise((resolve, reject) => {
    const s = JSON.stringify(body);
    const req = https.request({
      hostname, path: p, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s) },
    }, res => {
      let d = '';
      res.on('data', c => { d += c; });
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ _raw: d }); } });
    });
    req.on('error', reject);
    req.write(s);
    req.end();
  });
}

// Haal een verse access_token op via de opgeslagen refresh_token.
// Schrijft de nieuwe tokens terug naar settings.json.
async function refreshTebiToken(settings) {
  const refreshToken = settings.tebiRefreshToken;
  if (!refreshToken) throw new Error('Geen tebiRefreshToken in settings.json — run eerst: node tebi-setup.js');

  const tokens = await postJson(AUTH_DOMAIN, '/oauth/token', {
    grant_type:    'refresh_token',
    client_id:     CLIENT_ID,
    refresh_token: refreshToken,
  });

  if (tokens.error) throw new Error(`Tebi token refresh mislukt: ${tokens.error} — ${tokens.error_description}`);

  // Sla de verse tokens op
  try {
    let sf = {};
    try { sf = JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch {}
    sf.tebiToken = tokens.access_token;
    if (tokens.refresh_token) sf.tebiRefreshToken = tokens.refresh_token; // roterende refresh token
    fs.writeFileSync(SETTINGS, JSON.stringify(sf, null, 2));
  } catch (e) { console.warn('[tebi] kon settings.json niet updaten:', e.message); }

  return tokens.access_token;
}

async function fetchTebiDayOverview(date, token) {
  return new Promise((resolve, reject) => {
    const url = `${BASE}?date=${date}`;
    const req = https.request(url, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 inkoop-bot' },
    }, res => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => {
        if (res.statusCode === 401 || res.statusCode === 403) {
          return reject(Object.assign(new Error(`Tebi auth mislukt (${res.statusCode})`), { authExpired: true }));
        }
        if (res.statusCode === 404) return resolve(null);
        if (res.statusCode !== 200) return reject(new Error(`Tebi HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`Tebi JSON parse fout: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// Haalt dagrapport op; vernieuwt automatisch de token bij 401.
async function fetchTebiDayOverviewAuto(date, settings) {
  let token = settings.tebiToken;
  if (!token && !settings.tebiRefreshToken) {
    throw new Error('Geen tebiToken of tebiRefreshToken — run eerst: node tebi-setup.js');
  }
  try {
    return await fetchTebiDayOverview(date, token);
  } catch (e) {
    if (!e.authExpired) throw e;
    console.log('[tebi] token verlopen, automatisch vernieuwen...');
    token = await refreshTebiToken(settings);
    return await fetchTebiDayOverview(date, token);
  }
}

function qty(obj) {
  if (obj == null) return null;
  if (typeof obj === 'number') return obj;
  const v = parseFloat(obj.quantity ?? obj);
  return isNaN(v) ? null : v;
}

function parseTebiDayOverview(data, datum) {
  if (!data) return null;
  const aantal_gasten = data.metadata?.totalCovers ?? null;
  const aantal_tafels = data.revenue?.salesCount ?? null;
  const totale_omzet  = qty(data.summary?.totalSales) ?? qty(data.revenue?.totalGrossAmount);
  const cats      = data.revenue?.revenuePerCategory || [];
  const foodCats  = cats.filter(c => /food/i.test(c.category || ''));
  const barCats   = cats.filter(c => !/food/i.test(c.category || ''));
  const keuken_omzet = foodCats.reduce((s, c) => s + (qty(c.grossAmount) ?? 0), 0) || null;
  const bar_omzet    = barCats.reduce((s, c)  => s + (qty(c.grossAmount) ?? 0), 0) || null;
  const gerechten = cats
    .filter(c => (c.category || '').trim() && qty(c.grossAmount) > 0)
    .map(c => ({
      naam: (c.category || '').trim(), aantal: null, prijs: null,
      totaal: qty(c.grossAmount), categorie: (c.category || '').trim(),
      type: /food/i.test(c.category || '') ? 'Keuken' : 'Bar',
      food: /food/i.test(c.category || ''),
    }));
  return { datum, totale_omzet, bar_omzet, keuken_omzet, aantal_gasten, aantal_tafels, gerechten };
}

module.exports = { fetchTebiDayOverviewAuto, refreshTebiToken, parseTebiDayOverview };
