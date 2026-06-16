// node test-recept-import-lib.js
const assert = require('assert');
const { normEenheid, schatYield, basisNaarOutputEenheid, yieldVerlies, matchLokaal } = require('./src/recept-import-lib');
let n = 0; const ok = (m) => { n++; console.log('  ✓', m); };

// normEenheid
{
  assert(normEenheid('gr').basis === 'g' && normEenheid('kg').factor === 1000);
  assert(normEenheid('liter').basis === 'ml' && normEenheid('liter').factor === 1000);
  assert(normEenheid('st').basis === 'stuks' && normEenheid('blub') === null);
  ok('normEenheid mapt g/kg/ml/liter/stuks; onbekend => null');
}

// schatYield — Koji water: Koji 500 gr, Water 1 liter (=1000 ml), Zout 30 gr
{
  const y = schatYield([
    { hoeveelheid: 500, eenheid: 'gr' },
    { hoeveelheid: 1, eenheid: 'liter' },
    { hoeveelheid: 30, eenheid: 'gr' },
  ]);
  assert(y && y.geschat === true);
  assert(y.basis === 'ml' && y.yield === 1000, 'dominante basis ml=1000, kreeg ' + JSON.stringify(y));
  assert(basisNaarOutputEenheid(y.basis) === 'ml');
  ok('schatYield kiest dominante basis (water 1L > 530g) en flagt als schatting');
}
// schatYield — niets normaliseerbaar => null
{
  assert(schatYield([{ hoeveelheid: 1, eenheid: 'snufje' }, { hoeveelheid: null, eenheid: 'gr' }]) === null);
  ok('schatYield => null als niets normaliseerbaar is');
}

// yieldVerlies — methode uit naam → verliesfactor (reductie wint van gaar)
{
  assert(yieldVerlies('Tomaten reductie').factor === 0.5, 'reductie => 0.5');
  assert(yieldVerlies('Gegaarde knolselderij').factor === 0.8, 'garen => 0.8');
  assert(yieldVerlies('Kalfsfond ingekookt').methode === 'inkoken');
  assert(yieldVerlies('Demi glace gereduceerd').factor === 0.5, 'reductie wint van/naast gaar');
  assert(yieldVerlies('Mayonaise') === null, 'koud aanmengen => geen verlies');
  ok('yieldVerlies: reductie 0.5, garen 0.8, koud => null');
}

// matchLokaal
{
  const index = {
    ingredients: [
      { id: 'ing-water', namen: ['water'] },
      { id: 'ing-zout', namen: ['zout', 'zeezout'] },
      { id: 'ing-room', namen: ['slagroom', 'room 35%'] },
    ],
    bereidingen: [{ id: 'ber-saus', namen: ['tomatensaus'] }],
  };
  assert(matchLokaal('Water', index).id === 'ing-water');           // exact (case-insensitive)
  assert(matchLokaal('zeezout', index).id === 'ing-zout');          // exact op alias
  assert(matchLokaal('Koji', index) === null);                       // geen match => review
  const r = matchLokaal('room 35', index);                           // fuzzy
  assert(r && r.id === 'ing-room', 'fuzzy room: ' + JSON.stringify(r));
  ok('matchLokaal: exact + alias + fuzzy; geen match => null (review)');
}

console.log(`\n${n} tests geslaagd ✅`);
