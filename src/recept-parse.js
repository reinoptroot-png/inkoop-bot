// Receptencomposer — Fase 2: parser voor het Notion-receptsjabloon.
//
// Een receptpagina bevat twee platte Notion-tabellen:
//   meta (breedte 2):   Naam recept | <naam>
//                       Opbrengst   | <eind-yield, vaak leeg>
//                       Houdbaarheid | ... / Opslag | ...
//   ingrediënten (4):   Ingrediënten | Hoeveelheid | Eenheid | Opbrengst (ivt)
//
// Pure functie: input = al naar tekst afgevlakte rijen (string[][]). Geen Notion-types,
// dus testbaar zonder API.

function getal(v) {
  if (v == null) return null;
  const s = String(v).replace(',', '.').replace(/[^0-9.]/g, '').trim();
  if (!s) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

// "3,2 L" / "48 stuks" / "" -> { getal, eenheid }
function hoeveelheidMetEenheid(v) {
  const g = getal(v);
  const eenheid = String(v ?? '').replace(/[0-9.,]/g, '').trim() || null;
  return { getal: g, eenheid };
}

function parseRecept({ naam = null, metaRows = [], ingredientRows = [] }) {
  let opbrengst = null, opbrengstEenheid = null;
  for (const r of metaRows) {
    const k = (r[0] || '').toLowerCase().trim();
    if (k.startsWith('naam') && !naam) naam = (r[1] || '').trim() || null;
    if (k.startsWith('opbrengst')) { const p = hoeveelheidMetEenheid(r[1]); opbrengst = p.getal; opbrengstEenheid = p.eenheid; }
  }

  const regels = [];
  for (const r of ingredientRows) {
    const n = (r[0] || '').trim();
    if (!n) continue;
    if (n.toLowerCase().startsWith('ingredi')) continue;   // header-rij
    if (n.toLowerCase() === 'untitled') continue;          // lege sjabloon-rij
    if (/^stap\b/i.test(n) || /^methode\b/i.test(n)) continue;  // methode-stap, geen ingrediënt
    const heeftHoev = (r[1] || '').trim() !== '';
    if (n.endsWith(':') && !heeftHoev) continue;           // sectie-label ("Stap 2:", "Garnituur:")
    regels.push({
      naam: n,
      hoeveelheid: getal(r[1]),
      eenheid: (r[2] || '').trim() || null,
      opbrengst_ivt: getal(r[3]),
    });
  }

  // Compleet = heeft een eind-yield én minstens één echte ingrediëntregel.
  const compleet = opbrengst != null && opbrengst > 0 && regels.length > 0;
  return { naam, opbrengst, opbrengst_eenheid: opbrengstEenheid, regels, compleet };
}

module.exports = { parseRecept, getal, hoeveelheidMetEenheid };
