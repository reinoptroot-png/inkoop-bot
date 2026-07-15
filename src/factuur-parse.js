// Pure verwerking van het Claude-antwoord op een factuur-PDF (audit F-01).
//
// De cruciale scheiding: FOUT ≠ LEEG. Een afgekapt/ongeldig antwoord of niet-array is een
// mislukte parse (ok:false → de mail mag NIET als verwerkt gemarkeerd worden, volgende run
// probeert opnieuw); een geldige lege array is een geslaagde parse van een factuur zonder
// bruikbare regels (ok:true → markeren mag). Vroeger gaven beide gevallen stil [] terug en
// werd de mail altijd gemarkeerd — een factuur die tijdens een Claude-storing binnenkwam
// was daarmee voorgoed kwijt.
//
// Geen I/O, geen imports → testbaar (test-import-fixes.js).

// raw: de tekst uit data.content[0].text. → { ok, items, fout? }
function verwerkClaudeTekst(raw) {
  const clean = String(raw || '').replace(/```json|```/g, '').trim();
  let items;
  try {
    items = JSON.parse(clean);
  } catch (e) {
    return { ok: false, items: [], fout: `JSON parse mislukt: ${e.message}` };
  }
  if (!Array.isArray(items)) {
    return { ok: false, items: [], fout: `Claude gaf geen array terug (${typeof items})` };
  }
  // Validatie per item (ongewijzigd gedrag): naam moet string zijn, prijs een echt getal.
  const valid = items.filter(item => {
    if (!item || !item.ingredient || typeof item.ingredient !== 'string') return false;
    if (item.price == null || typeof item.price !== 'number' || isNaN(item.price)) return false;
    return true;
  });
  return { ok: true, items: valid, overgeslagen: items.length - valid.length };
}

module.exports = { verwerkClaudeTekst };
