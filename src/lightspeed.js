// Lightspeed dagrapport-CSV herkenning + parsing.
// Best-effort parser: kolommen worden op trefwoord herkend, zodat kleine
// formaatverschillen in de Lightspeed-export geen probleem zijn.

function isLightspeedDagrapport(email) {
  const from = (email.from?.value?.[0]?.address || '').toLowerCase();
  const subject = (email.subject || '').toLowerCase();
  const blob = `${from} ${subject}`;
  const looksLightspeed = /lightspeed|dagrapport|dagomzet|day\s?report|x-?rapport|z-?rapport|omzetrapport/i.test(blob);
  const heeftCsv = (email.attachments || []).some(a => /csv/i.test(a.contentType || '') || /\.csv$/i.test(a.filename || ''));
  return looksLightspeed && heeftCsv;
}

function splitCsv(text) {
  const firstLine = (text.split(/\r?\n/).find(l => l.trim()) || '');
  const delim = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';
  return text.split(/\r?\n/).filter(l => l.trim())
    .map(l => l.split(delim).map(c => c.replace(/^"|"$/g, '').trim()));
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

  // Datum: ISO of dd-mm-jjjj ergens in het bestand
  let datum = fallbackDatum;
  const iso = csvText.match(/(\d{4}-\d{2}-\d{2})/);
  const nl = csvText.match(/\b(\d{2})[-/](\d{2})[-/](\d{4})\b/);
  if (iso) datum = iso[1];
  else if (nl) datum = `${nl[3]}-${nl[2]}-${nl[1]}`;

  // Samenvattingswaarde: zoek rij waarvan eerste cel het label matcht, neem laatste numerieke cel
  const findVal = (re) => {
    for (const r of rows) {
      if (re.test((r[0] || '').toLowerCase())) {
        for (let i = r.length - 1; i >= 1; i--) { const n = toNum(r[i]); if (n != null) return n; }
      }
    }
    return null;
  };
  const totale_omzet  = findVal(/totale?\s*omzet|totaal\s*omzet|omzet\s*totaal|^total/);
  const bar_omzet     = findVal(/\bbar\b|dranken|drank/);
  const keuken_omzet  = findVal(/keuken|kitchen|^food\b|eten/);
  const aantal_gasten = findVal(/gasten|couverts?|covers|guests/);
  const aantal_tafels = findVal(/tafels?|tables/);

  // Gerechten-tabel: header-rij met naam- + aantal-kolom
  let hi = -1, cols = {};
  for (let i = 0; i < rows.length; i++) {
    const lc = rows[i].map(c => (c || '').toLowerCase());
    const naamI = lc.findIndex(c => /product|gerecht|artikel|naam|omschrijving|item/.test(c));
    const aantalI = lc.findIndex(c => /aantal|qty|quantity|stuks|count|verkocht/.test(c));
    if (naamI >= 0 && aantalI >= 0) {
      hi = i;
      cols = { naam: naamI, aantal: aantalI,
        prijs: lc.findIndex(c => /prijs|price|stuksprijs|unit/.test(c)),
        totaal: lc.findIndex(c => /totaal|total|bedrag|amount|omzet/.test(c)) };
      break;
    }
  }
  const gerechten = [];
  if (hi >= 0) {
    for (let i = hi + 1; i < rows.length; i++) {
      const r = rows[i];
      const naam = (r[cols.naam] || '').trim();
      const aantal = toNum(r[cols.aantal]);
      if (!naam || aantal == null) continue;
      gerechten.push({
        naam, aantal,
        prijs: cols.prijs >= 0 ? toNum(r[cols.prijs]) : null,
        totaal: cols.totaal >= 0 ? toNum(r[cols.totaal]) : null,
      });
    }
  }

  return { datum, totale_omzet, bar_omzet, keuken_omzet, aantal_gasten, aantal_tafels, gerechten };
}

module.exports = { isLightspeedDagrapport, parseDagrapport };
