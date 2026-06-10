// Lightspeed dagrapport: herkent de mail (afzender noreply@lightspeedrestaurant.com
// of "lightspeed"), haalt de CSV-downloadlink uit de body, en parseert het CSV.
// Best-effort parser: trefwoord-kolomherkenning, gerechten uit de CATEGORY REVENUES sectie.

function isLightspeed(email) {
  const from = (email.from?.value?.[0]?.address || '').toLowerCase();
  const subject = (email.subject || '').toLowerCase();
  return /lightspeedrestaurant\.com|lightspeed/i.test(from)
    || /lightspeed|dagrapport|dagomzet|omzetrapport|day\s?report/i.test(subject);
}

// Zoek een CSV-downloadlink in de e-mailbody (html of tekst)
function extractCsvLink(email) {
  const body = `${email.html || ''}\n${email.text || ''}`;
  const hrefs = [...body.matchAll(/href=["']([^"']+)["']/gi)].map(m => m[1]);
  const urls = [...body.matchAll(/https?:\/\/[^\s"'<>)]+/gi)].map(m => m[0]);
  const all = [...hrefs, ...urls];
  return all.find(u => /\.csv(\?|$)/i.test(u))
    || all.find(u => /csv|export|download|report|rapport/i.test(u))
    || null;
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

  // Datum
  let datum = fallbackDatum;
  const iso = csvText.match(/(\d{4}-\d{2}-\d{2})/);
  const nl = csvText.match(/\b(\d{2})[-/](\d{2})[-/](\d{4})\b/);
  if (iso) datum = iso[1];
  else if (nl) datum = `${nl[3]}-${nl[2]}-${nl[1]}`;

  // Samenvattingswaarde: rij waarvan eerste cel het label matcht → laatste numerieke cel
  const findVal = (re) => {
    for (const r of rows) {
      if (re.test((r[0] || '').toLowerCase())) {
        for (let i = r.length - 1; i >= 1; i--) { const n = toNum(r[i]); if (n != null) return n; }
      }
    }
    return null;
  };
  const totale_omzet  = findVal(/totale?\s*omzet|totaal\s*omzet|omzet\s*totaal|total\s*revenue|^revenue|^total\b/);
  const bar_omzet     = findVal(/\bbar\b|dranken|drank|beverage/);
  const keuken_omzet  = findVal(/keuken|kitchen|^food\b|eten/);
  const aantal_gasten = findVal(/gasten|couverts?|covers|guests/);
  const aantal_tafels = findVal(/tafels?|tables/);

  // Gerechten uit de CATEGORY REVENUES sectie
  const gerechten = [];
  const secIdx = rows.findIndex(r => /category\s*revenues/i.test(r.join(' ')));
  if (secIdx >= 0) {
    // header = eerstvolgende rij met ≥2 gevulde cellen
    let hi = secIdx + 1;
    while (hi < rows.length && rows[hi].filter(c => (c || '').trim()).length < 2) hi++;
    const lc = (rows[hi] || []).map(c => (c || '').toLowerCase());
    const hasKeywords = lc.some(c => /aantal|qty|quantity|count|prijs|price|totaal|total|amount|revenue|omzet/.test(c));
    const cNaam   = hasKeywords ? Math.max(0, lc.findIndex(c => /category|categorie|naam|name|omschrijving|product/.test(c))) : 0;
    let cAantal   = hasKeywords ? lc.findIndex(c => /aantal|qty|quantity|count|verkocht/.test(c)) : 1;
    let cPrijs    = hasKeywords ? lc.findIndex(c => /prijs|price|unit|gemiddeld|avg/.test(c)) : 2;
    let cTotaal   = hasKeywords ? lc.findIndex(c => /totaal|total|bedrag|amount|revenue|omzet/.test(c)) : 3;
    const dataStart = hasKeywords ? hi + 1 : hi;
    for (let i = dataStart; i < rows.length; i++) {
      const r = rows[i];
      const joined = r.join(' ').trim();
      if (!joined) break;                                                            // lege rij = einde sectie
      if (/^[A-Z][A-Z &\-]{4,}$/.test(joined) && r.filter(c => (c || '').trim()).length <= 2) break; // nieuwe sectie
      const naam = (r[cNaam] || '').trim();
      if (!naam || /category|categorie|total/i.test(naam)) continue;
      gerechten.push({
        naam,
        aantal: cAantal >= 0 ? toNum(r[cAantal]) : null,
        prijs:  cPrijs  >= 0 ? toNum(r[cPrijs])  : null,
        totaal: cTotaal >= 0 ? toNum(r[cTotaal]) : null,
      });
    }
  }

  return { datum, totale_omzet, bar_omzet, keuken_omzet, aantal_gasten, aantal_tafels, gerechten };
}

module.exports = { isLightspeedDagrapport, extractCsvLink, parseDagrapport };
