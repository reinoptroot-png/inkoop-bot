'use strict';
const path = require('path');
const fs = require('fs');
const { Client } = require('@notionhq/client');

const settings = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'settings.json'), 'utf8'));
const notion = new Client({ auth: settings.notionToken });
const DB_ID = 'b6258a232e6d4482b7b4f50cf449854f';

const UNIT = /(?:gr|g|kg|ml|l|ltr|cl|stuks?|st)\b/i;
const QTY  = /\d[\d.,/]*\s*(?:x\s*[\d.,]+\s*)?/;

function cleanName(naam) {
  let n = (naam || '').toLowerCase().trim();

  // Verwijder haakjes met inhoud: "(rauw)", "(lang)", "(groot)"
  n = n.replace(/\s*\([^)]*\)/g, '');

  // Verpakkingsinfo na komma: ", 250gr", ", 1 kg", ", 6x250ml", ", kist 5kg", ", tray 30st"
  // (?<!\d) slaat decimale komma over (bijv. "1,1 kg")
  n = n.replace(/(?<!\d),\s*(?:\d+\s+)?(?:kist(?:en)?|bos(?:sen)?|tray|doos|dozen|pak(?:ken)?|zak(?:ken)?|emmer|bak)\b.*/i, '');
  n = n.replace(new RegExp(`(?<!\\d),\\s*${QTY.source}${UNIT.source}.*`, 'i'), '');
  n = n.replace(/(?<!\d),\s*per\s*(?:kg|gr?|ml|l|stuks?|st)\b.*/i, '');

  // Gewicht/volume na spatie (alles vanaf dat punt): "250gr", "1,1 kg", "5/6 kg", "30st", "1l"
  n = n.replace(new RegExp(`\\s+${QTY.source}${UNIT.source}.*`, 'i'), '');

  // Niet-betekenisvolle woorden als laatste woord
  n = n.replace(/\s+(?:tray|bulk|rauw)\s*$/i, '');

  // Niet-betekenisvolle woorden overal
  n = n.replace(/\b(?:freiland|dagvers[e]?|neutraal)\b/gi, '');

  // Verwijder hangende leestekens/spaties aan het einde
  return n.replace(/\s+/g, ' ').replace(/[,.\s]+$/, '').trim();
}

async function fetchAll() {
  const results = [];
  let cursor;
  do {
    const r = await notion.databases.query({
      database_id: DB_ID,
      start_cursor: cursor,
      page_size: 100,
    });
    results.push(...r.results);
    cursor = r.has_more ? r.next_cursor : undefined;
  } while (cursor);
  return results;
}

async function main() {
  console.log('Ophalen producten uit Notion...');
  const pages = await fetchAll();
  const active = pages.filter(p => !p.archived);
  console.log(`${active.length} actieve producten gevonden\n`);

  // Bouw productlijst op
  const products = active.map(p => {
    const props = p.properties;
    const rawNaam = props['Ingredient']?.title?.[0]?.plain_text || '';
    return {
      id: p.id,
      rawNaam,
      cleanedNaam: cleanName(rawNaam),
      leverancier: props['Leverancier']?.rich_text?.[0]?.plain_text || '',
      kostprijs: props['Kostprijs']?.number ?? null,
      laatste_update: p.last_edited_time || '',
    };
  });

  // Groepeer op gecleande naam
  const groups = {};
  for (const p of products) {
    if (!groups[p.cleanedNaam]) groups[p.cleanedNaam] = [];
    groups[p.cleanedNaam].push(p);
  }

  const duplicateGroups = Object.entries(groups).filter(([, g]) => g.length > 1);
  const renames = products.filter(p => p.cleanedNaam !== p.rawNaam);

  console.log(`Gecleande namen: ${renames.length}`);
  console.log(`Duplicaatgroepen: ${duplicateGroups.length}\n`);

  let renamedCount = 0;
  let archivedCount = 0;
  const errors = [];

  // Stap 1: namen corrigeren (alleen voor non-duplicaten met gewijzigde naam)
  const toRename = products.filter(p => {
    const isDuplicate = groups[p.cleanedNaam].length > 1;
    return !isDuplicate && p.cleanedNaam !== p.rawNaam;
  });

  if (toRename.length > 0) {
    console.log(`--- Namen corrigeren (${toRename.length}) ---`);
    for (const p of toRename) {
      try {
        await notion.pages.update({
          page_id: p.id,
          properties: {
            Ingredient: { title: [{ text: { content: p.cleanedNaam } }] },
          },
        });
        console.log(`  renamed: "${p.rawNaam}" → "${p.cleanedNaam}"`);
        renamedCount++;
      } catch (e) {
        errors.push(`rename "${p.rawNaam}": ${e.message}`);
      }
    }
    console.log();
  }

  // Stap 2: duplicaten afhandelen
  if (duplicateGroups.length > 0) {
    console.log(`--- Duplicaten verwerken (${duplicateGroups.length} groepen) ---`);
    for (const [naam, group] of duplicateGroups) {
      // Kies winnaar: eerst met leverancier, dan met prijs, dan meest recent bewerkt
      const sorted = [...group].sort((a, b) => {
        const aScore = (a.leverancier ? 2 : 0) + (a.kostprijs != null ? 1 : 0);
        const bScore = (b.leverancier ? 2 : 0) + (b.kostprijs != null ? 1 : 0);
        if (bScore !== aScore) return bScore - aScore;
        return b.laatste_update.localeCompare(a.laatste_update);
      });

      const winner = sorted[0];
      const losers = sorted.slice(1);

      console.log(`  "${naam}" (${group.length}x)`);
      console.log(`    bewaar: "${winner.rawNaam}" (leverancier: ${winner.leverancier || '—'})`);

      // Naam corrigeren op winnaar als nodig
      if (winner.cleanedNaam !== winner.rawNaam) {
        try {
          await notion.pages.update({
            page_id: winner.id,
            properties: {
              Ingredient: { title: [{ text: { content: winner.cleanedNaam } }] },
            },
          });
          renamedCount++;
        } catch (e) {
          errors.push(`rename winner "${winner.rawNaam}": ${e.message}`);
        }
      }

      // Duplicaten archiveren
      for (const loser of losers) {
        try {
          await notion.pages.update({ page_id: loser.id, archived: true });
          console.log(`    gearchiveerd: "${loser.rawNaam}" (leverancier: ${loser.leverancier || '—'})`);
          archivedCount++;
        } catch (e) {
          errors.push(`archive "${loser.rawNaam}": ${e.message}`);
        }
      }
    }
    console.log();
  }

  // Samenvatting
  console.log('=== Samenvatting ===');
  console.log(`  Producten verwerkt : ${active.length}`);
  console.log(`  Namen gecorrigeerd : ${renamedCount}`);
  console.log(`  Gearchiveerd       : ${archivedCount}`);
  if (errors.length > 0) {
    console.log(`  Fouten             : ${errors.length}`);
    errors.forEach(e => console.log(`    - ${e}`));
  } else {
    console.log(`  Fouten             : 0`);
  }
}

main().catch(e => { console.error('Fatale fout:', e.message); process.exit(1); });
