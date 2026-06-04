const Imap = require('imap');
const { simpleParser } = require('mailparser');
const pdfParse = require('pdf-parse');
const fetch = require('node-fetch');
const NotionSync = require('./src/notion-sync');
const settings = require('./settings.json');

const DAYS = 180;
const LEVERANCIERS = [
  { naam: 'Lindenhoff', from: 'lindenhoff' },
  { naam: 'Sligro', from: 'sligro' },
  { naam: 'The Vanilla Family', from: 'thevanillafamily' },
  { naam: 'Vleeschatelier', from: 'vleeschatelier' }
];

function scanMailbox(user, pass, leverancier, days) {
  return new Promise((resolve) => {
    const imap = new Imap({
      user, password: pass,
      host: settings.imapHost || 'imap.one.com',
      port: 993, tls: true,
      tlsOptions: { rejectUnauthorized: false }
    });

    const since = new Date();
    since.setDate(since.getDate() - days);

    imap.once('ready', () => {
      imap.openBox('INBOX', true, (err) => {
        if (err) { imap.end(); return resolve([]); }
        imap.search([['SINCE', since], ['FROM', leverancier.from]], (err, results) => {
          if (err || !results || results.length === 0) { imap.end(); return resolve([]); }
          console.log('  ' + leverancier.naam + ': ' + results.length + ' mail(s)');
          const f = imap.fetch(results, { bodies: '' });
          const promises = [];
          f.on('message', msg => {
            const p = new Promise(res => {
              msg.on('body', stream => {
                simpleParser(stream, (err, parsed) => res(err ? null : parsed));
              });
            });
            promises.push(p);
          });
          f.once('end', async () => {
            const parsed = (await Promise.all(promises)).filter(Boolean);
            imap.end();
            resolve(parsed);
          });
        });
      });
    });
    imap.once('error', () => resolve([]));
    imap.connect();
  });
}

async function parsePdf(pdfBuffer, leverancierNaam, anthropicKey) {
  let text = '';
  try { const d = await pdfParse(pdfBuffer); text = d.text; } catch(e) { return []; }
  if (!text || text.trim().length < 50) return [];
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 2000,
        messages: [{ role: 'user', content: 'Extraheer alle ingredienten/producten met inkoopprijs uit deze factuur van ' + leverancierNaam + '. Geef ALLEEN een JSON array terug zonder uitleg: [{"ingredient":"naam","price":12.50,"eenheid":"kg"}]. Factuur:\n' + text.substring(0, 5000) }]
      })
    });
    const data = await response.json();
    const raw = data.content?.[0]?.text || '';
    const match = raw.match(/\[.*\]/s);
    if (!match) return [];
    const items = JSON.parse(match[0]);
    return items.map(i => ({ ...i, leverancier: leverancierNaam }));
  } catch(e) { return []; }
}

async function run() {
  console.log('=== Historische scan ' + DAYS + ' dagen ===');
  const notion = new NotionSync(settings);
  const accounts = [
    { user: settings.imapUser, pass: settings.imapPass, naam: 'Europizza' },
    { user: settings.imapUser2, pass: settings.imapPass2, naam: 'Europa' }
  ];

  let totalItems = 0;
  let batchNr = 0;

  for (const account of accounts) {
    console.log('\n--- ' + account.naam + ' ---');
    for (const lev of LEVERANCIERS) {
      const emails = await scanMailbox(account.user, account.pass, lev, DAYS);
      for (const email of emails) {
        if (!email.attachments) continue;
        for (const att of email.attachments) {
          if (!att.contentType || !att.contentType.includes('pdf')) continue;
          console.log('  PDF:', att.filename);
          const items = await parsePdf(att.content, lev.naam, settings.anthropicKey);
          if (items.length === 0) continue;
          console.log('    ->', items.length, 'producten — opslaan...');
          await notion.saveHistory(items);
          totalItems += items.length;
          batchNr++;
          console.log('    Batch', batchNr, 'opgeslagen (' + totalItems + ' totaal)');
        }
      }
    }
  }

  console.log('\n=== Klaar! ' + totalItems + ' historische prijspunten opgeslagen ===');
}

run().catch(e => { console.error('Fout:', e.message); process.exit(1); });
