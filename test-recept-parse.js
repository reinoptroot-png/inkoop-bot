// Test voor de receptsjabloon-parser:  node test-recept-parse.js
const assert = require('assert');
const { parseRecept, getal } = require('./src/recept-parse');
let n = 0; const ok = (m) => { n++; console.log('  ✓', m); };

// Echte data uit "Koji water" (Notion)
{
  const r = parseRecept({
    metaRows: [['Naam recept', 'Koji water'], ['Opbrengst', ''], ['Houdbaarheid', ''], ['Opslag', '']],
    ingredientRows: [
      ['Ingrediënten', 'Hoeveelheid', 'Eenheid', 'Opbrengst (ivt)'],
      ['Koji', '500', 'gr', ''],
      ['Water', '1 ', 'liter', ''],
      ['Zout', '30', 'gr', ''],
    ],
  });
  assert(r.naam === 'Koji water');
  assert(r.regels.length === 3, 'regels ' + r.regels.length);
  assert(r.regels[0].naam === 'Koji' && r.regels[0].hoeveelheid === 500 && r.regels[0].eenheid === 'gr');
  assert(r.regels[1].hoeveelheid === 1 && r.regels[1].eenheid === 'liter');
  assert(r.opbrengst === null && r.compleet === false, 'geen opbrengst => incompleet');
  ok('Koji water: 3 regels geparsed, geen yield => incompleet');
}

// Echt lege rijen + header overgeslagen; "Untitled" MÉT hoeveelheid blijft staan
// (= dropped page-mention / genest sub-recept dat anders verloren ging).
{
  const r = parseRecept({
    metaRows: [['Naam recept', 'Sauce au poivre'], ['Opbrengst', '2 L']],
    ingredientRows: [
      ['Ingrediënten', 'Hoeveelheid', 'Eenheid', 'Opbrengst (ivt)'],
      ['Untitled', '2000', 'ml', ''],   // dropped mention → behouden (gaat naar review)
      ['Untitled', '', '', ''],         // echt lege sjabloon-rij → overslaan
      ['', '', '', ''],                 // lege rij → overslaan
      ['Room', '500', 'ml', ''],
    ],
  });
  assert(r.naam === 'Sauce au poivre');
  assert(r.regels.length === 2 && r.regels.map(x => x.naam).join(',') === 'Untitled,Room', 'untitled-met-hoev behouden: ' + JSON.stringify(r.regels.map(x => x.naam)));
  assert(r.opbrengst === 2 && r.opbrengst_eenheid === 'L');
  assert(r.compleet === true, 'yield + regel => compleet');
  ok('lege/header overgeslagen; Untitled-met-hoeveelheid behouden; opbrengst geparsed');
}

// Methode-stappen / sectie-labels worden niet als ingrediënt opgepikt
{
  const r = parseRecept({
    metaRows: [['Naam recept', 'Kiwi salie saus'], ['Opbrengst', '']],
    ingredientRows: [
      ['Ingrediënten', 'Hoeveelheid', 'Eenheid', 'Opbrengst (ivt)'],
      ['Stap 1:', '', '', ''],
      ['Kiwi geschild', '500', 'gr', ''],
      ['Stap 2 PER DAG !!!', '', '', ''],
      ['Garnituur:', '', '', ''],
      ['Fijn zout', '10', 'gr', ''],
    ],
  });
  assert(r.regels.length === 2, 'alleen echte ingrediënten: ' + JSON.stringify(r.regels.map(x => x.naam)));
  assert(r.regels[0].naam === 'Kiwi geschild' && r.regels[1].naam === 'Fijn zout');
  ok('methode-stappen ("Stap 1:", "Stap 2 PER DAG !!!") en sectie-labels overgeslagen');
}

// getal-helper: komma, spaties, eenheidstekst
{
  assert(getal('1,5') === 1.5 && getal('30') === 30 && getal('1 ') === 1 && getal('') === null && getal('abc') === null);
  ok('getal() verwerkt komma/spaties/rommel');
}

console.log(`\n${n} tests geslaagd ✅`);
