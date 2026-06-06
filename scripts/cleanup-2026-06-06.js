'use strict';
// Handmatige database-opschoning uitgevoerd op 2026-06-06.
// Dit script documenteert de drie stappen en kan opnieuw worden gedraaid
// om de resultaten te verifiëren (droog — maakt geen wijzigingen).
//
// Wat er gedaan is:
//   Stap 1 — 15 non-food / schoonmaakartikelen gearchiveerd
//   Stap 2 — isDrank = true gezet op 20 dranken die de blacklist misten
//   Stap 3 — 12 exacte dubbelen gearchiveerd (schoonste naam bewaard)

const path = require('path');
const fs = require('fs');
const { Client } = require('@notionhq/client');

const settings = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'settings.json'), 'utf8'));
const notion = new Client({ auth: settings.notionToken });
const DB_ID = 'b6258a232e6d4482b7b4f50cf449854f';

// Stap 1 — gearchiveerde non-food page IDs
const ARCHIVED_NONFOOD = [
  { id: '377025fb-08ca-817c-a308-c5c845a05a4a', naam: 'sfg stalen tussenschot eur' },
  { id: '377025fb-08ca-81b4-8fda-c64a32dd3b7a', naam: 'handschoenen latex wit l cat iii' },
  { id: '377025fb-08ca-81c0-82a7-d2bac758af07', naam: 'dr. schnell perojet smart eco vaatwasmiddel' },
  { id: '377025fb-08ca-81be-b81f-fd9f61d45f2b', naam: 'schuurspons met grip geel/groen' },
  { id: '377025fb-08ca-81b1-91f6-f174e60c7d6d', naam: 'pb dikke bleek' },
  { id: '377025fb-08ca-8110-8ea9-e9fc21329f3f', naam: 'midi poetsrol eco 1-laags gerecycled' },
  { id: '377025fb-08ca-81f9-86bf-ded10ce3a521', naam: 'perfecto melksysteemreiniger' },
  { id: '377025fb-08ca-81d3-bc04-ed4c462b0834', naam: 'perfecto reinigingspoeder' },
  { id: '377025fb-08ca-812b-9786-e55498e0008b', naam: 'yoni dispenser x redlocker lease' },
  { id: '375025fb-08ca-81df-a71c-f9dddc99237d', naam: 'oven grill reiniger' },
  { id: '375025fb-08ca-818f-a7b0-d732952aaf72', naam: 'schuurspons' },
  { id: '375025fb-08ca-8101-814b-d16cea63f496', naam: 'vaatwasmiddel' },
  { id: '375025fb-08ca-8137-8b65-e3c8b10b3b74', naam: 'vacuumzak' },
  { id: '375025fb-08ca-812b-b242-cb4227cec522', naam: 'handzeep' },
  { id: '375025fb-08ca-81b7-875d-d8e2883f05b2', naam: 'poetsrol' },
];

// Stap 2 — isDrank = true gezet
const FLAGGED_DRANK = [
  { id: '377025fb-08ca-81e3-a747-e1756764ac7e', naam: 'rc ginger beer pet 1l' },
  { id: '377025fb-08ca-8192-b72c-f35bbc21aa12', naam: 'coca-cola zero pet 1.5l' },
  { id: '377025fb-08ca-8142-b63a-d22e1798eaca', naam: 'coca-cola regular pet 1.5l' },
  { id: '377025fb-08ca-8168-89c6-e6ba6dcb92b3', naam: 'coca-cola zero glas 20cl' },
  { id: '377025fb-08ca-8103-81b6-f92ff14ce9cc', naam: 'mist weizen - blik 33cl' },
  { id: '377025fb-08ca-81e1-b5eb-f44634e998a1', naam: 'njord hazy pale ale - blik 33cl' },
  { id: '377025fb-08ca-810b-92d8-d4220786913c', naam: 'loki golden ipa - blik 33cl' },
  { id: '375025fb-08ca-812a-8f0e-c46180736725', naam: 'fust bier' },
  { id: '375025fb-08ca-817b-b076-ec9dd6d1e32e', naam: 'rc ginger beer' },
  { id: '375025fb-08ca-81ef-82ab-e4180d570b8e', naam: 'alpro barista amandel' },
  { id: '375025fb-08ca-815e-8278-d3936e86e4aa', naam: 'coca-cola zero' },
  { id: '375025fb-08ca-8120-b5e1-dadd6f0ad0ac', naam: 'coca-cola' },
  { id: '375025fb-08ca-81b2-97f1-e1a9003d31c4', naam: 'mist weizen' },
  { id: '375025fb-08ca-8185-a7fa-cf5f380f10db', naam: 'njord hazy pale ale' },
  { id: '375025fb-08ca-81dd-8105-c95e1fa61da5', naam: 'loki golden ipa' },
  { id: '375025fb-08ca-81df-869e-debacbdab252', naam: 'appelsap' },
  { id: '375025fb-08ca-819e-945a-df950f9907b1', naam: 'koffiebonen' },
  { id: '375025fb-08ca-8199-a295-c82dde48f3fb', naam: 'wijn' },
  { id: '375025fb-08ca-8133-a24e-f018e3cfe877', naam: "pet'nat' rosé" },
  { id: '375025fb-08ca-81e7-9e9c-eaee3c12297a', naam: 'champagne' },
];

// Stap 3 — gearchiveerde dubbelen [archiveer → bewaard]
const ARCHIVED_DUPS = [
  { id: '377025fb-08ca-8188-b01f-e4ed195780bb', naam: 'coca-cola 20cl', bewaard: 'coca-cola' },
  { id: '377025fb-08ca-81eb-b9ec-f748992b1b4b', naam: 'boter guernsey zout rol dik 1,1 kg', bewaard: 'boter guernsey zout rol dik 1' },
  { id: '377025fb-08ca-81d1-abe2-e10c9fa4fe70', naam: 'waterkers grof (cresson)', bewaard: 'waterkers grof' },
  { id: '377025fb-08ca-81da-913c-f97d935eadbd', naam: 'boter neutraal bulk 5/6 kg', bewaard: 'boter neutraal bulk' },
  { id: '377025fb-08ca-8163-8255-fa5fdc342308', naam: 'slagroom, 1l', bewaard: 'slagroom' },
  { id: '377025fb-08ca-812c-bfde-d7a2f53d6e82', naam: 'daslookkappertjes op zoet/zuur 1kg', bewaard: 'daslookkappertjes op zoet/zuur' },
  { id: '374025fb-08ca-811b-9d31-db180d19a34d', naam: 'varken racks baambrugs big 11ribs', bewaard: 'varken racks baambrugs big 11 ribs' },
  { id: '377025fb-08ca-81f7-8a12-ddb929fb0dca', naam: 'roomkaas vers 60+, 1,8 kg', bewaard: 'roomkaas vers 60+' },
  { id: '377025fb-08ca-81bd-bc8c-c2ba88524e82', naam: 'beef garum 750ml', bewaard: 'beef garum' },
  { id: '377025fb-08ca-8115-9c4f-cfb539e2b85a', naam: 'mushroom garum 750ml', bewaard: 'mushroom garum' },
  { id: '377025fb-08ca-8173-bf7d-da5c0a95abfb', naam: 'fior di latte 8 bollen, 1 kg', bewaard: 'fior di latte 8 bollen' },
  { id: '374025fb-08ca-814e-8cf8-e38abcb84ac5', naam: 'lindenhoff boter', bewaard: 'boter' },
];

async function verify() {
  console.log('=== Verificatie opschoning 2026-06-06 ===\n');

  let ok = 0, fout = 0;

  for (const item of [...ARCHIVED_NONFOOD, ...ARCHIVED_DUPS]) {
    const page = await notion.pages.retrieve({ page_id: item.id });
    if (page.archived) {
      console.log(`✓ gearchiveerd: ${item.naam}`);
      ok++;
    } else {
      console.log(`✗ NIET gearchiveerd: ${item.naam}`);
      fout++;
    }
  }

  for (const item of FLAGGED_DRANK) {
    try {
      const page = await notion.pages.retrieve({ page_id: item.id });
      const isDrank = page.properties['Is drank']?.checkbox ?? false;
      if (page.archived || isDrank) {
        console.log(`✓ isDrank correct: ${item.naam}`);
        ok++;
      } else {
        console.log(`✗ isDrank NIET gezet: ${item.naam}`);
        fout++;
      }
    } catch(e) {
      console.log(`✗ FOUT bij ophalen: ${item.naam} — ${e.message}`);
      fout++;
    }
  }

  console.log(`\nResultaat: ${ok} ok, ${fout} fouten`);
}

verify().catch(e => { console.error('Fout:', e.message); process.exit(1); });
