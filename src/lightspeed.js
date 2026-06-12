// Lightspeed dagrapport: herkent de mail (afzender noreply@lightspeedrestaurant.com
// of "lightspeed"), haalt de CSV-downloadlink uit de body, en parseert het CSV.
// Best-effort parser: trefwoord-kolomherkenning, gerechten uit de CATEGORY REVENUES sectie.

function isLightspeed(email) {
  const from = (email.from?.value?.[0]?.address || '').toLowerCase();
  const subject = (email.subject || '').toLowerCase();
  return /lightspeedrestaurant\.com|lightspeed/i.test(from)
    || /lightspeed|dagrapport|dagomzet|omzetrapport|day\s?report/i.test(subject);
}

// HTML-entities in URLs decoderen (&amp; → &, &#38; → &, …). Lightspeed-mails
// bevatten ge-encode ampersands; zonder decode mist de querystring de token-param
// en geeft de server HTTP 400 "token not present".
function decodeUrl(u) {
  return String(u)
    .replace(/&amp;/gi, '&')
    .replace(/&#0*38;/g, '&')
    .replace(/&#x0*26;/gi, '&');
}

// Zoek een CSV-downloadlink in de e-mailbody (html of tekst). Voorkeur voor de
// expliciete CSV-variant (csv=1 / .csv) boven de gewone (HTML) dagrapport-link.
function extractCsvLink(email) {
  const body = `${email.html || ''}\n${email.text || ''}`;
  const hrefs = [...body.matchAll(/href=["']([^"']+)["']/gi)].map(m => m[1]);
  const urls = [...body.matchAll(/https?:\/\/[^\s"'<>)]+/gi)].map(m => m[0]);
  const all = [...new Set([...hrefs, ...urls].map(decodeUrl))];
  const link = all.find(u => /[?&]csv=1\b/i.test(u))      // expliciete CSV-export
    || all.find(u => /\.csv(\?|$)/i.test(u))               // bestand .csv
    || all.find(u => /csv|export|download|report|rapport/i.test(u))
    || null;
  return link;
}

function isLightspeedDagrapport(email) {
  return isLightspeed(email) && !!extractCsvLink(email);
}

function splitCsv(text) {
  const firstLine = (text.split(/\r?\n/).find(l => l.trim()) || '');
  const delim = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';
  return text.split(/\r?\n/).map(l => l.split(delim).map(c => c.replace(/^"|"$/g, '').trim()));
}

function toNum(s) {
  if (s == null) return null;
  let v = String(s).replace(/[^0-9,.\-]/g, '');
  if (v.includes(',') && v.includes('.')) v = v.replace(/\./g, '').replace(',', '.'); // 1.234,56 → 1234.56
  else if (v.includes(',')) v = v.replace(',', '.');                                  // 12,50 → 12.50
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}

function parseDagrapport(csvText, fallbackDatum = null) {
  const rows = splitCsv(csvText);

  // Datum: ISO, dd-mm-jjjj of d-m-jj (Lightspeed gebruikt "9-6-26")
  let datum = fallbackDatum;
  const iso = csvText.match(/(\d{4}-\d{2}-\d{2})/);
  const dmy4 = csvText.match(/\b(\d{2})[-/](\d{2})[-/](\d{4})\b/);
  const dmy2 = csvText.match(/\b(\d{1,2})-(\d{1,2})-(\d{2})\b/);
  const pad = n => String(n).padStart(2, '0');
  if (iso) datum = iso[1];
  else if (dmy4) datum = `${dmy4[3]}-${dmy4[2]}-${dmy4[1]}`;
  else if (dmy2) datum = `20${dmy2[3]}-${pad(dmy2[2])}-${pad(dmy2[1])}`;

  // Samenvattingswaarde: rij waarvan eerste cel het label matcht → EERSTE numerieke cel
  // (Lightspeed zet de waarde in kolom 1; latere cellen zijn "(53.81 avg)" e.d.)
  const findVal = (re) => {
    for (const r of rows) {
      if (re.test((r[0] || '').toLowerCase())) {
        for (let i = 1; i < r.length; i++) { const n = toNum(r[i]); if (n != null) return n; }
      }
    }
    return null;
  };
  const totale_omzet  = findVal(/^total\s*revenue|totale?\s*omzet|gross\s*sales/);
  const bar_omzet     = findVal(/^bar\s*revenue|\bbar\b|dranken|beverage/);
  const keuken_omzet  = findVal(/^restaurant\s*revenue|keuken|kitchen/);
  const aantal_gasten = findVal(/^customers|gasten|couverts?|covers|guests/);
  const aantal_tafels = findVal(/^tables?\s*served|tafels?|^tables/);

  // Gerechten uit de CATEGORY REVENUES sectie: per-gerecht = rijen met gevulde PRODUCT-kolom
  const gerechten = [];
  const secIdx = rows.findIndex(r => /category\s*revenues/i.test(r.join(' ')));
  if (secIdx >= 0) {
    let hi = secIdx + 1;
    while (hi < rows.length && !rows[hi].some(c => /product|category/i.test(c || ''))) hi++;
    const lc = (rows[hi] || []).map(c => (c || '').toLowerCase().trim());
    const findCol = (...res) => { for (const re of res) { const i = lc.findIndex(c => re.test(c)); if (i >= 0) return i; } return -1; };
    const cNaam   = findCol(/^product$/, /product/, /gerecht|artikel|omschrijving/, /^naam$|^name$/);
    const cAantal = findCol(/^#$/, /^aantal$|qty|quantity|count|verkocht/);
    const cPrijs  = findCol(/^price$/, /prijs|price|unit/);
    const cTotaal = findCol(/^total$/, /^totaal$/, /bedrag|amount/);
    const cCat    = findCol(/^category$/, /^categorie$/);
    const cType   = findCol(/category[\s-]*type/, /type/);
    // Per gerecht de CATEGORY-TYPE onthouden (Keuken = food, Wijn/Bier/… = drank).
    // Die staat alleen op de categorie-aggregaatrij (lege PRODUCT-cel); we dragen
    // hem mee naar de onderliggende productrijen.
    let huidigeCat = '', huidigeType = '';
    for (let i = hi + 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r.join('').trim()) break;                                  // lege rij = einde sectie
      const naam = (cNaam >= 0 ? r[cNaam] : '').trim();               // category-aggregaatrijen hebben lege PRODUCT-cel
      if (!naam) {                                                    // categorie-header
        const cat = cCat >= 0 ? (r[cCat] || '').trim() : '';
        if (cat) { huidigeCat = cat; huidigeType = cType >= 0 ? (r[cType] || '').trim() : ''; }
        continue;
      }
      if (/^total$/i.test(naam)) continue;
      gerechten.push({
        naam,
        aantal: cAantal >= 0 ? toNum(r[cAantal]) : null,
        prijs:  cPrijs  >= 0 ? toNum(r[cPrijs])  : null,
        totaal: cTotaal >= 0 ? toNum(r[cTotaal]) : null,
        categorie: huidigeCat,
        type: huidigeType,
        food: /keuken|kitchen|food/i.test(huidigeType),
      });
    }
  }

  return { datum, totale_omzet, bar_omzet, keuken_omzet, aantal_gasten, aantal_tafels, gerechten };
}

module.exports = { isLightspeedDagrapport, extractCsvLink, parseDagrapport };
