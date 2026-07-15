// Tests voor de drie kritieke import-fixes uit de audit (AUDIT_REPORT.md, 15 juli 2026):
//   [F-01] mail alleen als verwerkt markeren na een GESLAAGDE parse (fout ⇒ retrybaar)
//   [F-02] eenheid reist altijd mee met een prijs-update (tray-eieren ×30 onmogelijk)
//   [F-03] de ≥10%-prijspoort geldt in BEIDE paden (headless én scan.js/syncAll)
//   node test-import-fixes.js
const assert = require('assert');
let n = 0;
function ok(naam) { n++; console.log('  ✓', naam); }

// ── [F-01] verwerkClaudeTekst: fout ≠ leeg ──────────────────────────────────────
// Een Claude-storing, afgekapte JSON of niet-array gaf vroeger stil [] terug, waarna de mail
// tóch als verwerkt gemarkeerd werd — de factuur was dan voorgoed kwijt. De pure verwerker
// onderscheidt nu ok:false (retrybaar) van ok:true + lege lijst (echt niets bruikbaars).
{
  const { verwerkClaudeTekst } = require('./src/factuur-parse');

  const goed = verwerkClaudeTekst('```json\n[{"ingredient":"tomaat","price":2.5,"eenheid":"kg"}]\n```');
  assert.strictEqual(goed.ok, true);
  assert.strictEqual(goed.items.length, 1);
  assert.strictEqual(goed.items[0].ingredient, 'tomaat');

  const kapot = verwerkClaudeTekst('[{"ingredient":"tomaat","price":2.5');   // afgekapt
  assert.strictEqual(kapot.ok, false, 'afgekapte JSON moet ok:false zijn (retry), niet een lege lijst');

  const geenArray = verwerkClaudeTekst('{"foutmelding":"geen factuur"}');
  assert.strictEqual(geenArray.ok, false, 'niet-array moet ok:false zijn');

  const leeg = verwerkClaudeTekst('[]');
  assert.strictEqual(leeg.ok, true, 'een echt lege factuur is WEL geslaagd (niets te importeren)');
  assert.strictEqual(leeg.items.length, 0);

  // Validatie blijft: items zonder naam of met niet-numerieke prijs vallen af, de rest blijft.
  const gemengd = verwerkClaudeTekst('[{"ingredient":"kaas","price":8},{"price":3},{"ingredient":"x","price":"vier"}]');
  assert.strictEqual(gemengd.ok, true);
  assert.strictEqual(gemengd.items.length, 1, 'alleen het geldige item blijft over');
  ok('[F-01] verwerkClaudeTekst: fout ⇒ retrybaar, leeg ⇒ geslaagd, validatie intact');
}

// ── [F-02] bouwPrijsUpdateProps: eenheid reist mee met de prijs ─────────────────
// updatePriceOnly schreef Kostprijs maar nooit Eenheid: "eieren" (stuk, €0,32) kreeg na een
// tray-scan €9,60 bij eenheid stuk ⇒ 30× te duur in elk recept. De props-bouwer zet de eenheid
// nu altijd naast de prijs (en laat 'm alleen weg als de scanregel er geen heeft).
{
  const { bouwPrijsUpdateProps } = require('./src/notion-sync');
  assert.strictEqual(typeof bouwPrijsUpdateProps, 'function', 'F-02: bouwPrijsUpdateProps ontbreekt in notion-sync');

  const met = bouwPrijsUpdateProps({ price: 9.6, eenheid: 'tray 30 st' });
  assert.strictEqual(met.props['Kostprijs'].number, 9.6);
  assert.strictEqual(met.props['Eenheid'].rich_text[0].text.content, 'tray 30 st',
    'F-02: eenheid moet in de basis-props naast de prijs staan');

  const zonder = bouwPrijsUpdateProps({ price: 2.5 });
  assert.ok(!zonder.props['Eenheid'], 'geen eenheid op de scanregel ⇒ bestaande eenheid ongemoeid laten');

  // Leverancier alleen invullen als het veld nog leeg is (bestaand gedrag, geborgd).
  const lev = bouwPrijsUpdateProps({ price: 1, eenheid: 'kg', leverancier: 'Vitelia', bestaandeLeverancier: 'Zuivelhoeve' });
  assert.ok(!lev.props['Leverancier'], 'bestaande leverancier niet overschrijven');
  const levLeeg = bouwPrijsUpdateProps({ price: 1, eenheid: 'kg', leverancier: 'Vitelia', bestaandeLeverancier: '' });
  assert.strictEqual(levLeeg.props['Leverancier'].rich_text[0].text.content, 'Vitelia');

  // Optionele velden horen in extra (fallback-pad zonder deze velden blijft werken).
  const vol = bouwPrijsUpdateProps({ price: 1, eenheid: 'kg', rawData: 'artikelnr: 61168', gramPerEenheid: 5000, vandaag: '2026-07-15' });
  assert.strictEqual(vol.extra['Gram per inkoopeenheid'].number, 5000);
  assert.strictEqual(vol.extra['Laatste update'].date.start, '2026-07-15');
  assert.ok(vol.extra['Raw data'].rich_text[0].text.content.includes('61168'));
  ok('[F-02] bouwPrijsUpdateProps: Eenheid altijd naast Kostprijs');
}

// ── [F-03] prijsPoortBesluit: één poort voor beide paden ────────────────────────
// headless.js had de ≥drempel%-poort (pending-melding, geen directe write); het dagelijkse
// scan.js/syncAll-pad NIET — een kistprijs-parsefout van +900% werd daar direct weggeschreven.
// Zelfde besluitfunctie voor beide paden; drempel default 10 (settings.alertThreshold).
{
  const { prijsPoortBesluit } = require('./src/prijs-poort');

  const groot = prijsPoortBesluit({ oudePrijs: 10, nieuwePrijs: 100, drempelPct: 10 });
  assert.strictEqual(groot.besluit, 'poort', '+900% moet naar de poort');
  assert.ok(Math.abs(groot.pct - 900) < 1e-9);

  const daling = prijsPoortBesluit({ oudePrijs: 10, nieuwePrijs: 8.9, drempelPct: 10 });
  assert.strictEqual(daling.besluit, 'poort', '−11% moet ook naar de poort (|pct| telt)');

  const klein = prijsPoortBesluit({ oudePrijs: 10, nieuwePrijs: 10.5, drempelPct: 10 });
  assert.strictEqual(klein.besluit, 'update', '+5% mag direct door');

  const rand = prijsPoortBesluit({ oudePrijs: 10, nieuwePrijs: 11, drempelPct: 10 });
  assert.strictEqual(rand.besluit, 'poort', 'precies op de drempel (≥) hoort bij de poort — zoals headless');

  // Pariteit met bestaand headless-gedrag (bewust, zie audit F-15): zonder oude prijs geen poort.
  const eerste = prijsPoortBesluit({ oudePrijs: null, nieuwePrijs: 480, drempelPct: 10 });
  assert.strictEqual(eerste.besluit, 'update', 'eerste prijs (geen oude) volgt bewust het headless-gedrag [F-15 open]');
  ok('[F-03] prijsPoortBesluit: drempel, daling, rand, eerste-prijs-pariteit');
}

console.log(`\n${n} tests geslaagd ✅`);
