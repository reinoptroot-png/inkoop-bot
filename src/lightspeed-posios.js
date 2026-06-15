// Lightspeed Restaurant L-Series (PosiOS) dagrapport — net als Tebi via een
// browser-sessie-token (geen API-portal client/secret nodig).
//
// Ontdekt via de backoffice (euc2-web.posios.com): de dashboard/rapporten halen
// data op bij het "interval report" endpoint met een X-Auth-Token header. Die
// token is de sessie-`apitoken` uit de ingelogde backoffice (sessionStorage),
// éénmalig overgenomen in settings.json als lsPosToken.
//
//   POST https://reporting-prod-euc2-eks.posios.com/reporting/data/intervalreport
//   headers: { 'Content-Type': 'application/json', 'X-Auth-Token': <token> }
//   body: { requestedItems, from, to, intervals:{timezone,startOfDay,startOfMonth,startOfWeek} }
//
// Response-mapping (geverifieerd 2026-06-12 tegen "Euro Pizza Restaurant BV"):
//   revenue.revenueTotal.totalTaxExcl                  → totale_omzet (excl btw)
//   revenue.revenuePerType.restaurant.totalTaxExcl     → keuken_omzet
//   revenue.revenuePerType.bar.totalTaxExcl            → bar_omzet
//   sum(receiptAggregates.receipts[].total.numberOfCustomers) → aantal_gasten
//   receiptAggregates.receipts.length                 → aantal_tafels (bonnen)
//   som van receiptTotalPerCategory over alle bonnen   → gerechten[] (categorie-niveau)
//
// Per-product (losse gerechten) komt uit het oudere PosServer "bigreporting"
// JSON-RPC endpoint (in een iframe) — nog niet geïntegreerd; categorie-niveau is
// de huidige dekking, identiek aan de Tebi-integratie.

const https = require('https');

const REPORT_HOST = 'reporting-prod-euc2-eks.posios.com';
const REPORT_PATH = '/reporting/data/intervalreport';
const BIGREP_HOST = 'bigreporting-prod-euc2.posios.com';
const BIGREP_PATH = '/PosServer/JSON-RPC';
const TIMEZONE    = 'Europe/Amsterdam';

// Categorieën die als drank (bar) tellen wanneer we per categorie classificeren.
// De API geeft al een bar/restaurant-split; dit is alleen voor de gerechten-lijst.
const BAR_CATEGORIE = /bier|cocktail|frisdrank|koffie|wijn|wit|rood|rose|rosé|mousserend|oranje|sterk|alcohol|sap|thee/i;

// minuten dat Europe/Amsterdam vóór UTC ligt op een gegeven instant (60 of 120).
function amsterdamOffsetMin(date) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = fmt.formatToParts(date).reduce((a, x) => { a[x.type] = x.value; return a; }, {});
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour === '24' ? 0 : p.hour, p.minute, p.second);
  return (asUTC - date.getTime()) / 60000;
}

// Horeca-dag: 04:00 lokale tijd → 04:00 de volgende dag (zoals de backoffice toont;
// in de zomer = 02:00Z..02:00Z, geverifieerd). DST-veilig via de lokale offset.
function businessDayRange(dateStr) {
  const guess = new Date(`${dateStr}T04:00:00Z`);
  const off = amsterdamOffsetMin(guess);
  const fromMs = Date.parse(`${dateStr}T04:00:00Z`) - off * 60000;
  return {
    from: new Date(fromMs).toISOString(),
    to: new Date(fromMs + 24 * 3600 * 1000).toISOString(),
  };
}

// Middernacht-lokale dag (00:00 → 24:00 Europe/Amsterdam) in epoch-ms. Dit venster
// gebruikt het product-rapport (getProductAnalytics); de productsom incl btw is
// geverifieerd gelijk aan de dag-omzet (€5954,85 op 2026-06-12). DST-veilig.
function midnightDayRangeMs(dateStr) {
  const guess = new Date(`${dateStr}T00:00:00Z`);
  const off = amsterdamOffsetMin(guess);
  const fromMs = Date.parse(`${dateStr}T00:00:00Z`) - off * 60000;
  return { fromMs, toMs: fromMs + 24 * 3600 * 1000 - 1000 };
}

function postReport(token, requestedItems, from, to) {
  const body = JSON.stringify({
    requestedItems, from, to,
    intervals: { timezone: TIMEZONE, startOfDay: 2, startOfMonth: 1, startOfWeek: 1 },
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: REPORT_HOST, path: REPORT_PATH, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-Auth-Token': token,
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let d = '';
      res.on('data', c => { d += c; });
      res.on('end', () => {
        if (res.statusCode === 401 || res.statusCode === 403) {
          return reject(Object.assign(new Error(`Lightspeed auth mislukt (${res.statusCode})`), { authExpired: true }));
        }
        if (res.statusCode !== 200) return reject(new Error(`Lightspeed HTTP ${res.statusCode}: ${d.slice(0, 200)}`));
        try { resolve(JSON.parse(d)); }
        catch (e) { reject(new Error(`Lightspeed JSON parse fout: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// PosServer JSON-RPC (legacy "bigreporting") — gebruikt door het product-rapport.
// Token gaat als eerste param mee (geen header).
function postBigReporting(method, params) {
  const body = JSON.stringify({ id: 0, method, params });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: BIGREP_HOST, path: BIGREP_PATH, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let d = '';
      res.on('data', c => { d += c; });
      res.on('end', () => {
        if (res.statusCode === 401 || res.statusCode === 403) {
          return reject(Object.assign(new Error(`Lightspeed auth mislukt (${res.statusCode})`), { authExpired: true }));
        }
        if (res.statusCode !== 200) return reject(new Error(`bigreporting HTTP ${res.statusCode}: ${d.slice(0, 200)}`));
        try { resolve(JSON.parse(d)); }
        catch (e) { reject(new Error(`bigreporting JSON parse fout: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const isDrankNaam = (n) => /\b(bier|beer|wijn|wine|cocktail|gin|wodka|rum|whisky|cognac|likeur|porto|sherry|cava|prosecco|champagne|cola|fanta|sprite|frisdrank|sap|tonic|spa|water|koffie|coffee|thee|tea|espresso|cappuccino|latte|club.?mate|negroni|spritz|aperol|campari)\b/i.test(n || '');

// Per product (gerecht): orderAmount + omzet, via getProductAnalytics over de
// middernacht-dag. totaal = excl btw (totalPrice is incl). Food/bar-classificatie:
// btw 9% of niet-drank-naam = keuken, anders bar.
async function fetchProductGerechten(token, dateStr) {
  const { fromMs, toMs } = midnightDayRangeMs(dateStr);
  const resp = await postBigReporting('manager.getProductAnalytics', [token, fromMs, toMs]);
  const rows = resp?.result || [];
  return rows
    .filter(p => (p.orderAmount || 0) !== 0 && !/discount/i.test(p.name || ''))
    .map(p => {
      const vat = p.vat || 0;
      const totaalExcl = Math.round(((p.totalPrice || 0) / (1 + vat / 100)) * 100) / 100;
      const drank = vat >= 21 || isDrankNaam(p.name);
      return {
        naam: (p.name || '').trim(),
        aantal: p.orderAmount,
        prijs: p.price ?? null,
        totaal: totaalExcl,
        vat,
        categorie: p.pId || null,
        type: drank ? 'Bar' : 'Keuken',
        food: !drank,
      };
    })
    .sort((a, b) => b.totaal - a.totaal);
}

function parsePosiosDay(revenueResp, receiptResp, datum) {
  const rev = revenueResp?.revenue || {};
  const totale_omzet  = rev.revenueTotal?.totalTaxExcl ?? null;
  const keuken_omzet  = rev.revenuePerType?.restaurant?.totalTaxExcl ?? null;
  const bar_omzet     = rev.revenuePerType?.bar?.totalTaxExcl ?? null;

  const recs = receiptResp?.receiptAggregates?.receipts || [];
  const aantal_tafels = recs.length || null;
  const aantal_gasten = recs.reduce((s, r) => s + (r.total?.numberOfCustomers || 0), 0) || null;

  // Categorie-totalen aggregeren over alle bonnen → gerechten (categorie-niveau).
  const catTotals = {};
  for (const r of recs) {
    const c = r.receiptTotalPerCategory || {};
    for (const naam in c) {
      if (naam === 'Discounts') continue;
      catTotals[naam] = (catTotals[naam] || 0) + (c[naam].totalTaxExcl || 0);
    }
  }
  const gerechten = Object.entries(catTotals)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([naam, totaal]) => ({
      naam, aantal: null, prijs: null,
      totaal: Math.round(totaal * 100) / 100,
      categorie: naam,
      type: BAR_CATEGORIE.test(naam) ? 'Bar' : 'Keuken',
      food: !BAR_CATEGORIE.test(naam),
    }));

  return { datum, totale_omzet, bar_omzet, keuken_omzet, aantal_gasten, aantal_tafels, gerechten };
}

// Haal het volledige dagrapport op voor één datum (YYYY-MM-DD).
async function fetchPosiosDagrapport(dateStr, token) {
  if (!token) throw new Error('Geen Lightspeed token (lsPosToken) — neem de apitoken over uit de ingelogde backoffice.');
  const { from, to } = businessDayRange(dateStr);
  const [revenueResp, receiptResp] = await Promise.all([
    postReport(token, ['revenue'], from, to),
    postReport(token, ['receiptAggregates'], from, to),
  ]);
  const dr = parsePosiosDay(revenueResp, receiptResp, dateStr);

  // Per-product gerechten via het legacy product-rapport. Mislukt dit (of leeg),
  // dan blijft de categorie-niveau lijst uit parsePosiosDay staan als fallback.
  try {
    const producten = await fetchProductGerechten(token, dateStr);
    if (producten.length) dr.gerechten = producten;
  } catch (e) {
    if (e.authExpired) throw e;
    // stil: categorie-niveau fallback blijft staan
  }
  return dr;
}

module.exports = { fetchPosiosDagrapport, parsePosiosDay, businessDayRange };
