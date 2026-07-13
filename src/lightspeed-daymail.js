// Lightspeed Restaurant (L-Series) dag-mail parser — het gratis alternatief voor de betaalde API.
// Lightspeed mailt elke ochtend 04:00 een "day report" met een tokenized CSV-link
// (euc2.posios.com/PosServer/ReportServlet?...&csv=1) die zónder login te downloaden is.
// Deze module parset die CSV naar exact dezelfde dagrapport-vorm als lightspeed-posios-scan:
//   { datum, totale_omzet, bar_omzet, keuken_omzet, aantal_gasten, aantal_tafels, gerechten[] }
//   gerechten[i] = { naam, aantal, prijs, totaal, categorie, type, food }
// Bedragen zijn excl. btw (net), consistent met de bestaande scans.

const https = require('https');

// CSV-link(s) uit de mail-body (HTML of tekst) — PDF- en CSV-link delen dezelfde token.
function extractDayMailCsvUrl(body) {
  // Host bevat soms een expliciete poort ("euc2.posios.com:443") — die moet in de match zitten.
  const m = String(body || '').match(/https:\/\/[a-z0-9.-]+(?::\d+)?\/PosServer\/ReportServlet\?[^"'\s<>]*csv=1/i);
  return m ? m[0].replace(/&amp;/g, '&') : null;
}

// "12-7-26" (d-m-jj) → "2026-07-12"
function parseRapportDatum(kop) {
  const m = String(kop || '').match(/(\d{1,2})-(\d{1,2})-(\d{2,4})/);
  if (!m) return null;
  const [, d, mnd, j] = m;
  const jaar = j.length === 2 ? `20${j}` : j;
  return `${jaar}-${String(mnd).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function num(s) {
  const v = parseFloat(String(s ?? '').replace(/[^\d.,-]/g, '').replace(',', '.'));
  return Number.isFinite(v) ? v : null;
}

// De CSV is een puntkomma-gescheiden "rapport-print": secties met koppen, geen vaste tabel.
function parseDayMailCsv(csvText) {
  const regels = String(csvText).split(/\r?\n/).map(r => r.split(';').map(c => c.replace(/^"|"$/g, '').trim()));

  const datum = parseRapportDatum((regels.find(r => /SUMMARY REPORT/i.test(r[0])) || [])[0]);

  // Netto-omzet: som van NET REVENUE uit de VAT-sectie (excl. btw — consistent met de oude scans).
  let totale_omzet = null;
  const vatKop = regels.findIndex(r => r[0] === 'VAT RATE');
  if (vatKop >= 0) {
    let som = 0, n = 0;
    for (let i = vatKop + 1; i < regels.length && /%$/.test(regels[i][0] || ''); i++) {
      const net = num(regels[i][1]);
      if (net != null) { som += net; n++; }
    }
    if (n) totale_omzet = Math.round(som * 100) / 100;
  }

  const gastenRij = regels.find(r => /^Customers:?$/i.test(r[0]));
  const tafelsRij = regels.find(r => /^Tables Served:?$/i.test(r[0]));
  const aantal_gasten = gastenRij ? num(gastenRij[1]) : null;
  const aantal_tafels = tafelsRij ? num(tafelsRij[1]) : null;

  // CATEGORY REVENUES: kolommen CATEGORY;CATEGORY-TYPE;PRODUCT;DISCOUNT;PRICE;#;TOTAL;COST;PROFIT;VAT RATE;VAT;TOTAL REVENUE
  // Categorie-rij: CATEGORY gevuld, PRODUCT leeg. Product-rij: PRODUCT gevuld. Net = TOTAL REVENUE − VAT.
  // Categorie-rij: CATEGORY gevuld, PRODUCT leeg. Product-rij: PRODUCT gevuld. De sectie loopt
  // aaneengesloten door tot de eerste lege regel (daarna komt "TABLE REVENUES").
  // CATEGORY-TYPE "Keuken" = keuken/food; al het andere (Sterk, Wijn, Bier, Frisdrank,
  // Koffie / Thee, Alcoholvrij bier) = bar.
  const gerechten = [];
  let bar = 0, keuken = 0;
  const catKop = regels.findIndex(r => r[0] === 'CATEGORY' && r[2] === 'PRODUCT');
  if (catKop >= 0) {
    let huidigeCat = '', isKeuken = true;
    for (let i = catKop + 1; i < regels.length; i++) {
      const r = regels[i];
      if (!r.some(c => c)) break;                          // lege regel = einde sectie
      const [cat, catType, product, , prijs, aantal, , , , , vat, totRev] = r;
      if (cat && !product) {                               // categorie-totaalregel
        huidigeCat = cat;
        isKeuken = /keuken|kitchen|food/i.test(catType || '');
        const net = (num(totRev) ?? 0) - (num(vat) ?? 0);
        if (isKeuken) keuken += net; else bar += net;
        continue;
      }
      if (product && !/^discount\b/i.test(product)) {      // korting-regels niet als gerecht tellen
        const net = Math.round((((num(totRev) ?? 0) - (num(vat) ?? 0))) * 100) / 100;
        gerechten.push({
          naam: product,
          aantal: num(aantal),
          prijs: num(prijs),
          totaal: net,
          categorie: huidigeCat,
          type: isKeuken ? 'Keuken' : 'Bar',
          food: isKeuken,
        });
      }
    }
  }

  // Zelfde product kan meermaals voorkomen (andere prijs, bv. korting-variant) → aggregeren.
  const perNaam = new Map();
  for (const g of gerechten) {
    const key = g.naam.toLowerCase();
    if (!perNaam.has(key)) { perNaam.set(key, { ...g }); continue; }
    const b = perNaam.get(key);
    b.aantal = (b.aantal ?? 0) + (g.aantal ?? 0);
    b.totaal = Math.round((b.totaal + g.totaal) * 100) / 100;
  }
  const gerechtenAgg = [...perNaam.values()].sort((a, b) => (b.totaal ?? 0) - (a.totaal ?? 0));

  return {
    datum,
    totale_omzet,
    bar_omzet: Math.round(bar * 100) / 100 || null,
    keuken_omzet: Math.round(keuken * 100) / 100 || null,
    aantal_gasten,
    aantal_tafels,
    gerechten: gerechtenAgg,
  };
}

function downloadCsv(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`CSV-download HTTP ${res.statusCode}`)); }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

module.exports = { extractDayMailCsvUrl, parseDayMailCsv, parseRapportDatum, downloadCsv };
