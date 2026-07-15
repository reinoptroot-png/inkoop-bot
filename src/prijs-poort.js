// F-03 (audit): één prijspoort voor BEIDE verwerkingspaden.
//
// headless.js had de poort al (≥ drempel% afwijking ⇒ pending-melding, géén directe write);
// het dagelijkse launchd-pad (scan.js → syncAll) NIET — een kistprijs-parsefout van +900%
// werd daar zonder bevestiging weggeschreven. Beide paden nemen hun besluit nu via deze
// pure functie, zodat de twee pijplijnen nooit meer uiteen kunnen lopen op deze regel.
//
// Bewuste pariteit met bestaand headless-gedrag: zonder oude prijs (null/0) is er geen
// referentie en gaat de update door — dat is audit-bevinding F-15 en die staat nog open;
// hier niet stilletjes "meegefixt" (scope-besluit 15 juli 2026).

// → { besluit: 'poort' | 'update', pct: number | null }
function prijsPoortBesluit({ oudePrijs, nieuwePrijs, drempelPct = 10 }) {
  if (!(oudePrijs > 0)) return { besluit: 'update', pct: null };
  const pct = ((nieuwePrijs - oudePrijs) / oudePrijs) * 100;
  return { besluit: Math.abs(pct) >= drempelPct ? 'poort' : 'update', pct };
}

// Pending prijs_groot-melding, met dezelfde anti-loop-dedup als headless (bestaatAlMelding):
// zelfde ingredient + zelfde nieuwe prijs is al gemeld ⇒ niet opnieuw. sb mag null zijn
// (dan alleen het poort-besluit, geen melding — zelfde als headless zonder Supabase).
async function schrijfPrijsGrootMelding(sb, m) {
  if (!sb) return false;
  try {
    const { data: rows } = await sb.from('scan_meldingen').select('id')
      .eq('type', 'prijs_groot').eq('ingredient_naam', m.ingredient_naam)
      .eq('prijs_nieuw', m.prijs_nieuw).limit(1);
    if ((rows || []).length) return false;
    const { error } = await sb.from('scan_meldingen').insert({
      type: 'prijs_groot', status: 'pending', gelezen: false, ...m,
    });
    if (error) { console.warn(`[poort] melding niet geschreven ("${m.ingredient_naam}"):`, error.message); return false; }
    return true;
  } catch (e) {
    console.warn('[poort] melding-schrijffout:', e.message);
    return false;
  }
}

module.exports = { prijsPoortBesluit, schrijfPrijsGrootMelding };
