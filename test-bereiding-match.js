// Test voor de pure parse-/disambiguatie-logica van de Fase 2-matcher.
// Geen API/netwerk nodig:  node test-bereiding-match.js
const assert = require('assert');
const { parseMatchResponse } = require('./src/bereiding-match');

const ingredients = [{ canonical: 'boter', id: 'ing-boter' }, { canonical: 'tomaat', id: 'ing-tomaat' }];
const bereidingen = [{ canonical: 'tomatensaus', id: 'ber-saus' }, { canonical: 'kippenbouillon', id: 'ber-bouillon' }];
let n = 0; const ok = (m) => { n++; console.log('  ✓', m); };

// 1. Ingredient-match
{
  const r = parseMatchResponse('{"type":"ingredient","canonical":"boter","confidence":97,"uitleg":"x"}', ingredients, bereidingen);
  assert(r && r.type === 'ingredient' && r.id === 'ing-boter' && r.confidence === 97);
  ok('ingredient-match mapt naar juiste id');
}
// 2. Bereiding-match (zelfde naam zou óók kunnen verwarren — type stuurt de lijstkeuze)
{
  const r = parseMatchResponse('{"type":"bereiding","canonical":"tomatensaus","confidence":88,"uitleg":"x"}', ingredients, bereidingen);
  assert(r && r.type === 'bereiding' && r.id === 'ber-saus');
  ok('bereiding-match kiest de bereidingenlijst');
}
// 3. Te lage confidence (<30) => null. De routing 70/95 doet de aanroeper (zoals de Scan Bot).
{
  assert(parseMatchResponse('{"type":"ingredient","canonical":"boter","confidence":20,"uitleg":""}', ingredients, bereidingen) === null);
  assert(parseMatchResponse('{"type":"ingredient","canonical":"boter","confidence":40,"uitleg":""}', ingredients, bereidingen) !== null);
  ok('confidence <30 => null; >=30 => match (routing 70/95 doet de aanroeper)');
}
// 4. null-type / geen match
{
  assert(parseMatchResponse('{"type":null,"canonical":null,"confidence":10,"uitleg":""}', ingredients, bereidingen) === null);
  ok('expliciete null-match => null');
}
// 5. Haiku verzint een naam die niet bestaat => null (geen hallucinatie doorlaten)
{
  assert(parseMatchResponse('{"type":"ingredient","canonical":"truffelolie","confidence":99,"uitleg":""}', ingredients, bereidingen) === null);
  ok('onbekende canonical => null');
}
// 6. type wijst naar verkeerde lijst => geen kruisbesmetting
{
  // "tomatensaus" bestaat als bereiding, niet als ingredient → type:ingredient mag NIET matchen
  assert(parseMatchResponse('{"type":"ingredient","canonical":"tomatensaus","confidence":95,"uitleg":""}', ingredients, bereidingen) === null);
  ok('type bepaalt de lijst — geen kruismatch tussen ingredient/bereiding');
}
// 7. Rommel/geen JSON => null
{
  assert(parseMatchResponse('sorry ik weet het niet', ingredients, bereidingen) === null);
  ok('niet-JSON antwoord => null');
}

console.log(`\n${n} tests geslaagd ✅`);
