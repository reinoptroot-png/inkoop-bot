// Euro Food Monitor — classificeer bereidingen als RECEPTUUR vs METHODE (Passard).
//
// In de Notion-bron staan kok-recepten door elkaar: échte recepturen (mayonaise, sauzen, jus,
// olie…) die een kostprijs hebben en interessant zijn voor de calculatie, én methodes ("hoe gaar
// je asperges", "pekelen", "snijden") die alleen instructie zijn. Voor de calculatie willen we
// alleen recepturen. Dit zet methodes op status='methode' (telt niet mee, geen "prijs onbekend"-ruis).
//
// Heuristiek (conservatief — we verbergen NOOIT een bereiding die een kostprijs heeft):
//   1) naam bevat een receptuur-zelfstandignaamwoord (saus/mayo/jus/olie/…) → RECEPTUUR
//   2) anders: techniek-werkwoord (garen/bakken/snijden/pekelen/…) ÉN géén kostprijs → METHODE
//      (heeft het wél een prijs, dan is het een gekoste component → laten staan, niet verbergen)
//   3) anders: ONBESLIST → laten staan (actief)
//
//   node classify-bereidingen.js          # DRY-RUN (toont de voorgestelde methodes)
//   node classify-bereidingen.js --sql    # print UPDATE-SQL voor de Supabase SQL-editor

require('dotenv').config();
const SQL = process.argv.includes('--sql');
const sb = require('@supabase/supabase-js').createClient(
  process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY);

const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ' ').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

// Receptuur = een ding dat je máákt (heeft een kostprijs). Zelfstandige naamwoorden.
const RECEPTUUR = ['saus', 'saus', 'mayo', 'mayonaise', 'dressing', 'vinaigrette', 'bechamel', 'bechamelle',
  'jus', 'fond', 'bouillon', 'olie', 'compote', 'sorbet', 'ijs', 'beslag', 'veloute', 'veloute',
  'hollandaise', 'bearnaise', 'aioli', 'pesto', 'tapenade', 'gel', 'espuma', 'creme', 'room',
  'sap', 'pekel', 'marinade', 'coulis', 'gastrique', 'ganache', 'puree', 'mousse', 'emulsie',
  'dashi', 'miso', 'chutney', 'relish', 'salsa', 'dip', 'spread', 'boter', 'mayo', 'kruidenolie',
  'siroop', 'gel', 'jam', 'confituur', 'praline', 'ketchup', 'crumble', 'crème'];
// Methode = een handeling/techniek (werkwoorden + voltooid deelwoorden).
// Bewust WEGGELATEN: aanmaken/aangemaakt (= aanmengen) en opslaan/opgeslagen (= opkloppen) —
// die leveren juist een gekoste component op.
const METHODE = ['garen', 'gegaard', 'koken', 'gekookt', 'bakken', 'gebakken', 'braden', 'gebraden',
  'grillen', 'gegrild', 'frituren', 'gefrituurd', 'pekelen', 'gepekeld', 'blancheren', 'geblancheerd',
  'snijden', 'gesneden', 'hakken', 'gehakt', 'raspen', 'geraspt', 'plukken', 'geplukt', 'portioneren',
  'afwegen', 'wegen', 'roosteren', 'geroosterd', 'ontvliezen', 'schillen', 'geschild', 'wellen',
  'weken', 'geweekt', 'drogen', 'gedroogd', 'temperen', 'zeven', 'wassen', 'gewassen'];

// heeftPrijs: heeft deze bereiding een berekende prijs (= gekoste component)?
function classify(naam, heeftPrijs) {
  const toks = new Set(norm(naam).split(' ').filter(Boolean));
  const recept = RECEPTUUR.find(w => toks.has(w));
  if (recept) return { soort: 'receptuur', reden: `bevat "${recept}"` };
  const meth = METHODE.find(w => toks.has(w));
  if (meth && !heeftPrijs) return { soort: 'methode', reden: `techniek "${meth}", geen kostprijs` };
  if (meth && heeftPrijs) return { soort: 'receptuur', reden: `techniek "${meth}" maar wél een kostprijs → gekoste component` };
  return { soort: 'onbeslist', reden: 'geen duidelijk signaal' };
}

(async () => {
  if (!SQL) console.log('=== DRY-RUN — geen writes ===\n');
  const { data: ber } = await sb.from('bereiding').select('id, status, canonical_bereiding(canonical_naam), bereiding_kostprijs(prijs_per_eenheid)');
  const rijen = (ber || []).map(b => ({ id: b.id, naam: b.canonical_bereiding?.canonical_naam || '', status: b.status, heeftPrijs: b.bereiding_kostprijs?.prijs_per_eenheid != null }));

  const telling = { receptuur: 0, methode: 0, onbeslist: 0 };
  const nieuweMethodes = [];   // nu actief, voorgesteld → methode
  for (const r of rijen) {
    const c = classify(r.naam, r.heeftPrijs);
    telling[c.soort]++;
    if (c.soort === 'methode' && r.status !== 'methode') nieuweMethodes.push({ ...r, reden: c.reden });
  }

  if (SQL) {
    if (!nieuweMethodes.length) { console.log('-- geen nieuwe methodes voorgesteld'); return; }
    console.log('-- Passard: zet voorgestelde methodes op status=methode (tellen niet mee in de calculatie)');
    console.log("update public.bereiding set status='methode', updated_at=now()");
    console.log(' where id in (' + nieuweMethodes.map(m => `'${m.id}'`).join(', ') + ');');
    return;
  }

  console.log(`Totaal: ${rijen.length} bereidingen`);
  console.log(`  receptuur (telt mee): ${telling.receptuur}`);
  console.log(`  methode (telt NIET mee): ${telling.methode}  (waarvan ${nieuweMethodes.length} nu nog actief → voorstel)`);
  console.log(`  onbeslist (blijft actief): ${telling.onbeslist}\n`);
  console.log('Voorgestelde methodes (nu actief → methode):');
  nieuweMethodes.slice(0, 40).forEach(m => console.log(`  • ${m.naam}  (${m.reden})`));
  if (nieuweMethodes.length > 40) console.log(`  … en ${nieuweMethodes.length - 40} meer`);
  console.log('\nDraai met --sql voor de UPDATE-SQL.');
})();
