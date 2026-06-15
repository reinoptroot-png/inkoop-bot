// Lightspeed Restaurant K-Series REST API — dagrapport fetcher + parser.
// API docs: https://api-docs.lsk.lightspeed.app/
//
// Endpoint: GET https://api.lsk.lightspeed.app/f/v2/business-location/{id}/sales-daily
//           ?date=YYYY-MM-DD&include=revenue_center
//
// Auth: OAuth2 (authorization_code flow). refresh_token opgeslagen in Supabase
//       instellingen (restaurant='europizza', key='ls_refresh_token').
//       Eenmalige setup: node lightspeed-api-setup.js
//
// Vereiste GitHub secrets:
//   LS_CLIENT_ID             — Lightspeed Developer Portal
//   LS_CLIENT_SECRET         — Lightspeed Developer Portal
//   LS_BUSINESS_LOCATION_ID  — integer ID van de Europizza vestiging
//
// Response-mapping (sales-daily):
//   sales[type=SALE].salesLines[].totalNetAmountWithTax → totale_omzet
//   revenue_center.name ~"keuken/kitchen/food"          → keuken_omzet
//   overige revenue centers                              → bar_omzet
//   sum(sale.nbCovers, dineIn=true)                      → aantal_gasten
//   count distinct sale.tableNumber (SALE, dineIn)       → aantal_tafels
//   gerechten: per naam aggregaat (food only, int stuks) → gerechten[]

const https   = require('https');
const fs      = require('fs');
const path    = require('path');

const TOKEN_HOST = 'auth.lsk.lightspeed.app';
const TOKEN_PATH = '/realms/k-series/protocol/openid-connect/token';
const API_BASE   = 'api.lsk.lightspeed.app';

const SETTINGS = path.join(__dirname, '..', 'settings.json');

// Dranken die nooit als keuken/food geteld worden (fallback als revenue_center ontbreekt).
const DRANK_BLACKLIST = [
  'coca cola','coca-cola','pepsi','fanta','sprite','7up','ice tea','club mate',
  'alpro','ginger beer','arla','schulp','heineken','cynar','sourcy','lipton',
  'red bull','redbull','fever tree','tonic water','bier','beer','wijn','wine',
  'prosecco','champagne','frisdrank','appelsap','vruchtensap','siroop','syrup',
  'melk','milk','oat drink','soy drink','haverdrink','koffie','coffee','thee',
  'tea','nespresso','senseo','karnemelk','smoothie','cocktail','energy drink',
  'cava','rosé','rose','gin','vodka','rum','whisky','whiskey','cognac','porto',
  'aperol','spritz','campari','limoncello','grappa','aquavit','jenever',
];

function isDrankNaam(naam) {
  const n = (naam || '').toLowerCase();
  return DRANK_BLACKLIST.some(d => n.includes(d));
}

function isKeukenRc(rcName) {
  return /keuken|kitchen|food/i.test(rcName || '');
}

// HTTP helpers
function httpsPost(hostname, p, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname, path: p, method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded',
                   'Content-Length': Buffer.byteLength(body) } },
      res => {
        let d = '';
        res.on('data', c => { d += c; });
        res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch { resolve({ status: res.statusCode, body: d }); } });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function httpsGet(hostname, p, token) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname, path: p, method: 'GET',
        headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' } },
      res => {
        let d = '';
        res.on('data', c => { d += c; });
        res.on('end', () => {
          if (res.statusCode === 401 || res.statusCode === 403) {
            const err = new Error(`Lightspeed auth fout (${res.statusCode})`);
            err.authExpired = true;
            return reject(err);
          }
          if (res.statusCode === 404) return resolve(null);
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`Lightspeed HTTP ${res.statusCode}: ${String(d).slice(0, 200)}`));
          }
          try { resolve(JSON.parse(d)); }
          catch (e) { reject(new Error(`Lightspeed JSON parse fout: ${e.message}`)); }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

// Vernieuw access_token via de opgeslagen refresh_token.
// Schrijft nieuwe tokens naar settings.json + geeft verse access_token terug.
async function refreshLsToken(settings) {
  const { lsClientId, lsClientSecret, lsRefreshToken } = settings;
  if (!lsRefreshToken) throw new Error('Geen lsRefreshToken — run eerst: node lightspeed-api-setup.js');
  if (!lsClientId || !lsClientSecret) throw new Error('LS_CLIENT_ID of LS_CLIENT_SECRET ontbreekt');

  const body = new URLSearchParams({
    grant_type:    'refresh_token',
    client_id:     lsClientId,
    client_secret: lsClientSecret,
    refresh_token: lsRefreshToken,
  }).toString();

  const { status, body: tokens } = await httpsPost(TOKEN_HOST, TOKEN_PATH, body);

  if (status !== 200 || tokens.error) {
    throw new Error(`Lightspeed token refresh mislukt (${status}): ${tokens.error || ''} — ${tokens.error_description || ''}`);
  }

  // Persisteer verse tokens in settings.json
  try {
    let sf = {};
    try { sf = JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch {}
    sf.lsAccessToken  = tokens.access_token;
    if (tokens.refresh_token) sf.lsRefreshToken = tokens.refresh_token;
    fs.writeFileSync(SETTINGS, JSON.stringify(sf, null, 2));
  } catch (e) {
    console.warn('[ls-api] kon settings.json niet updaten:', e.message);
  }

  return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token || lsRefreshToken };
}

async function fetchSalesDaily(date, businessLocationId, accessToken) {
  const p = `/f/v2/business-location/${businessLocationId}/sales-daily?date=${date}&include=revenue_center`;
  return httpsGet(API_BASE, p, accessToken);
}

// Haalt dagrapport op; vernieuwt automatisch de token bij 401.
async function fetchLsDayOverviewAuto(date, settings) {
  let accessToken = settings.lsAccessToken;
  const blId = settings.lsBusinessLocationId;

  if (!blId) throw new Error('LS_BUSINESS_LOCATION_ID ontbreekt in settings.json');

  const doFetch = (token) => fetchSalesDaily(date, blId, token);

  if (!accessToken) {
    console.log('[ls-api] geen cached access_token, verse ophalen...');
    const refreshed = await refreshLsToken(settings);
    accessToken = refreshed.accessToken;
  }

  try {
    return await doFetch(accessToken);
  } catch (e) {
    if (!e.authExpired) throw e;
    console.log('[ls-api] access_token verlopen, automatisch vernieuwen...');
    const refreshed = await refreshLsToken(settings);
    return await doFetch(refreshed.accessToken);
  }
}

// Aggregeer per productnaam (food only).
function aggregeerGerechten(sales) {
  const map = {};
  for (const sale of sales) {
    if (sale.type !== 'SALE') continue;
    const rcName = sale.revenue_center?.name || '';
    for (const line of (sale.salesLines || [])) {
      const naam = (line.name || '').trim();
      if (!naam) continue;

      // Food-classificatie: revenue_center-naam (primair) → DRANK_BLACKLIST (fallback)
      const food = rcName
        ? isKeukenRc(rcName)
        : !isDrankNaam(naam);
      if (!food) continue;

      const qty   = line.quantity || 0;
      const total = line.totalNetAmountWithTax || 0;
      if (!map[naam]) {
        map[naam] = {
          naam,
          aantal:    0,
          prijs:     qty ? Math.round((total / qty) * 100) / 100 : null,
          totaal:    0,
          categorie: rcName || '',
          type:      'Keuken',
          food:      true,
        };
      }
      map[naam].aantal += qty;
      map[naam].totaal  = Math.round((map[naam].totaal + total) * 100) / 100;
    }
  }
  // Aantallen als gehele stuks (Lightspeed kan decimalen geven door kortingen)
  return Object.values(map).map(g => ({ ...g, aantal: Math.round(g.aantal) }));
}

function parseLsDayOverview(data, datum) {
  if (!data) return null;
  const sales = (data.sales || []);
  const salesOnly = sales.filter(s => s.type === 'SALE');

  let totale_omzet  = 0;
  let keuken_omzet  = 0;
  let bar_omzet     = 0;
  let aantal_gasten = 0;
  const tables = new Set();

  for (const sale of salesOnly) {
    const rcName   = sale.revenue_center?.name || '';
    const isKeuken = isKeukenRc(rcName);
    const isDineIn = sale.dineIn !== false;

    aantal_gasten += (sale.nbCovers || 0);
    if (isDineIn && sale.tableNumber) tables.add(String(sale.tableNumber));

    for (const line of (sale.salesLines || [])) {
      const amount = line.totalNetAmountWithTax || 0;
      totale_omzet += amount;
      if (isKeuken) keuken_omzet += amount;
      else bar_omzet += amount;
    }
  }

  const round = v => Math.round(v * 100) / 100;

  return {
    datum,
    totale_omzet:  round(totale_omzet)  || null,
    keuken_omzet:  round(keuken_omzet)  || null,
    bar_omzet:     round(bar_omzet)     || null,
    aantal_gasten: aantal_gasten        || null,
    aantal_tafels: tables.size          || null,
    gerechten:     aggregeerGerechten(sales),
    data_volledig: data.dataComplete    ?? null,
  };
}

module.exports = { fetchLsDayOverviewAuto, refreshLsToken, parseLsDayOverview };
