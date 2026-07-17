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

// ── Trust-all mailbox: pakbon@europa.rest slaat de afzender-whitelist over ──────
// pakbon@europa.rest is een gecureerde dropbox; élke afzender daarin is een echte leverancier.
// Zonder trust-all vielen pakbonnen van niet-gewhiteliste afzenders (Fix Fisch via "Leon van
// der Plas", de Sligro-emballagebon) stil weg terwijl de mailbox wél elke dag gescand wordt.
{
  const { isTrustAllMailbox, trustAllMailboxen } = require('./src/imap-scanner');

  // Default (geen env): alleen pakbon@europa.rest is trust-all.
  assert.strictEqual(isTrustAllMailbox('pakbon@europa.rest', undefined), true, 'pakbon@ hoort trust-all');
  assert.strictEqual(isTrustAllMailbox('PAKBON@Europa.REST', undefined), true, 'hoofdletter-ongevoelig');
  assert.strictEqual(isTrustAllMailbox('facturen@europa.rest', undefined), false, 'facturen@europa.rest houdt de whitelist');
  assert.strictEqual(isTrustAllMailbox('facturen@europizza.rest', undefined), false, 'bedrijfs-inbox houdt de whitelist');
  assert.strictEqual(isTrustAllMailbox('', undefined), false, 'lege afzender is niet trust-all');

  // Env-override: meerdere mailboxen, komma-gescheiden.
  assert.strictEqual(isTrustAllMailbox('inkoop@europa.rest', 'pakbon@europa.rest, inkoop@europa.rest'), true, 'env-override voegt toe');
  assert.strictEqual(isTrustAllMailbox('pakbon@europa.rest', 'inkoop@europa.rest'), false, 'env-override vervangt de default');
  // Leeg env = géén trust-all mailbox (bewuste uitschakeling).
  assert.strictEqual(trustAllMailboxen('').length, 0, 'lege env ⇒ geen trust-all mailbox');
  assert.strictEqual(isTrustAllMailbox('pakbon@europa.rest', ''), false, 'lege env schakelt trust-all uit');
  ok('[trust-all] pakbon@europa.rest slaat whitelist over; overige mailboxen niet');
}

// ── [F-08] Dedup: laatste factuurprijs wint — geen gemiddelde ───────────────────
// Bindend besluit 16 juli 2026. Vroeger middelde de dedup (prijs = lopend gemiddelde) én voegde
// leveranciers samen; nu wint de regel met de recentste factuurdatum, zonder datum de laatste.
{
  const { dedupLaatstePrijs } = require('./src/imap-scanner');

  // Zelfde ingrediënt, twee facturen: de recentste datum wint (geen gemiddelde van 2,10 en 2,80).
  const r1 = dedupLaatstePrijs([
    { ingredient: 'Tomaat', price: 2.10, factuurdatum: '2026-06-01', leverancier: 'A' },
    { ingredient: 'tomaat', price: 2.80, factuurdatum: '2026-07-14', leverancier: 'B' },
  ]);
  assert.strictEqual(r1.length, 1, 'één unieke tomaat');
  assert.strictEqual(r1[0].price, 2.80, 'F-08: recentste factuurdatum wint, geen gemiddelde');
  assert.strictEqual(r1[0].leverancier, 'B', 'leverancier van de winnende regel, niet samengevoegd');

  // Oudere datum als tweede binnengekomen mag de recentste NIET overschrijven.
  const r2 = dedupLaatstePrijs([
    { ingredient: 'ui', price: 4.50, factuurdatum: '2026-07-14' },
    { ingredient: 'ui', price: 9.99, factuurdatum: '2026-06-01' },
  ]);
  assert.strictEqual(r2[0].price, 4.50, 'F-08: oudere factuur overschrijft de recentste niet');

  // Zonder datum: de later-verwerkte vermelding wint (deterministische fallback).
  const r3 = dedupLaatstePrijs([
    { ingredient: 'zout', price: 1.00 },
    { ingredient: 'zout', price: 1.20 },
  ]);
  assert.strictEqual(r3[0].price, 1.20, 'F-08: zonder datum wint de laatste vermelding');

  // Verschillende ingrediënten blijven allebei staan; lege naam valt weg.
  const r4 = dedupLaatstePrijs([
    { ingredient: 'appel', price: 1 }, { ingredient: 'peer', price: 2 }, { ingredient: '', price: 9 },
  ]);
  assert.strictEqual(r4.length, 2, 'twee echte ingrediënten, lege naam genegeerd');
  ok('[F-08] dedupLaatstePrijs: laatste factuurprijs wint, geen middeling/leverancier-merge');
}

// ── Retry-op-rate-limit: transiente Claude-fouten worden opnieuw geprobeerd ──────
// Zonder retry faalde de backlog-catch-up massaal op 429 (rate limit). isTransienteFout bepaalt
// wat herhaalbaar is; backoffMs de wachttijd (Retry-After eerst, anders exponentieel met plafond).
{
  const { isTransienteFout, backoffMs } = require('./src/imap-scanner');

  assert.strictEqual(isTransienteFout(429), true, '429 rate limit is transient');
  assert.strictEqual(isTransienteFout(529), true, '529 overbelast is transient');
  assert.strictEqual(isTransienteFout(503), true, '5xx serverfout is transient');
  assert.strictEqual(isTransienteFout(200), false, '200 is niet transient');
  assert.strictEqual(isTransienteFout(400), false, '400 invalid_request is persistent, niet opnieuw');
  assert.strictEqual(isTransienteFout(null, 'overloaded_error'), true, 'overloaded_error is transient');
  assert.strictEqual(isTransienteFout(null, 'rate_limit_error'), true, 'rate_limit_error is transient');
  assert.strictEqual(isTransienteFout(null, 'invalid_request_error'), false, 'invalid_request is persistent');

  assert.strictEqual(backoffMs(1, null), 2000, 'exponentieel: poging 1 → 2s');
  assert.strictEqual(backoffMs(3, null), 8000, 'exponentieel: poging 3 → 8s');
  assert.strictEqual(backoffMs(9, null), 20000, 'exponentieel met plafond 20s');
  assert.strictEqual(backoffMs(1, '15'), 15000, 'Retry-After (15s) wint');
  assert.strictEqual(backoffMs(1, '120'), 30000, 'Retry-After met plafond 30s');
  ok('[retry] isTransienteFout + backoffMs: rate limit/overbelast opnieuw, met Retry-After');
}

console.log(`\n${n} tests geslaagd ✅`);
