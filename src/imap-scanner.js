const Imap = require('imap');
const { simpleParser } = require('mailparser');
const pdfParse = require('pdf-parse');
const fetch = require('node-fetch');

// Bekende leveranciers: volledig e-mailadres of domein → leveranciersnaam
const KNOWN_SENDERS = {
  'finance@lindenhoff.nl':                          'Lindenhoff',
  'lindenhoff.nl':                                  'Lindenhoff',
  'facturen@vleeschatelier.nl':                     'Vleeschatelier',
  'vleeschatelier.nl':                              'Vleeschatelier',
  'info@thevanillafamily.com':                      'Vanilla Venture',
  'administratie@vanillaventure.nl':                'Vanilla Venture',
  'vanillaventure.nl':                              'Vanilla Venture',
  'noreply@notifications.order2cash.com':           'Sligro',
  'info@novitalia.nl':                              'Novitalia',
  'novitalia.nl':                                   'Novitalia',
  'info-aspergesamsterdam@deliver.moneybird.com':   'Asperges Amsterdam',
};

function leverancierFromEmail(address) {
  if (!address) return '';
  const lower = address.toLowerCase();
  if (KNOWN_SENDERS[lower]) return KNOWN_SENDERS[lower];
  const domain = lower.split('@')[1];
  return (domain && KNOWN_SENDERS[domain]) || '';
}

class ImapScanner {
  constructor(settings) {
    this.settings = settings;
  }

  fetchEmails({ markSeen = true } = {}) {
    return new Promise((resolve, reject) => {
      const imap = new Imap({
        user: this.settings.imapUser,
        password: this.settings.imapPass,
        host: this.settings.imapHost || 'imap.one.com',
        port: 993,
        tls: true,
        tlsOptions: { rejectUnauthorized: false }
      });

      const emails = [];

      imap.once('ready', () => {
        imap.openBox('INBOX', false, (err, box) => {
          if (err) return reject(err);

          // Zoek ongelezen mails
          imap.search(['UNSEEN'], (err, results) => {
            if (err) return reject(err);
            if (!results || results.length === 0) {
              imap.end();
              return resolve([]);
            }

            const fetch = imap.fetch(results, { bodies: '', markSeen });
            const promises = [];

            fetch.on('message', (msg) => {
              const p = new Promise((res) => {
                msg.on('body', (stream) => {
                  simpleParser(stream, (err, parsed) => {
                    if (err) return res(null);
                    res(parsed);
                  });
                });
              });
              promises.push(p);
            });

            fetch.once('end', async () => {
              const parsed = await Promise.all(promises);
              imap.end();
              resolve(parsed.filter(Boolean));
            });
          });
        });
      });

      imap.once('error', reject);
      imap.connect();
    });
  }

  async parsePdfWithClaude(pdfBuffer, filename) {
    let text = '';
    try {
      const data = await pdfParse(pdfBuffer);
      text = data.text;
    } catch (e) {
      return [];
    }

    if (!text || text.trim().length < 50) return [];

    const prompt = `Je bent een assistent die leveranciersfacturen analyseert voor een restaurant.

Hieronder staat de tekst van een factuur of pakbon. Extraheer alle ingrediënten/producten met hun inkoopprijs.

Retourneer ALLEEN een JSON array, geen uitleg, geen markdown backticks. Formaat:
[
  { "ingredient": "naam van het product", "price": 12.50, "eenheid": "kg" },
  ...
]

Regels:
- "ingredient": de productnaam, zo duidelijk mogelijk, in het Nederlands of originele taal
- "price": de prijs per eenheid (per kg, per liter, per stuk), als getal
- "eenheid": de eenheid (kg, liter, stuk, etc.)
- Als de prijs per doos/krat is, bereken dan de prijs per kg/stuk als dat mogelijk is
- Sla producten over waarbij je de eenheidsprijs niet kunt bepalen

Factuur tekst:
${text.substring(0, 6000)}`;

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.settings.anthropicKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-opus-4-5',
          max_tokens: 2000,
          messages: [{ role: 'user', content: prompt }]
        })
      });

      const data = await response.json();
      const raw = data.content?.[0]?.text || '';
      const clean = raw.replace(/```json|```/g, '').trim();
      return JSON.parse(clean);
    } catch (e) {
      console.error('Claude parse error:', e.message);
      return [];
    }
  }

  async scan({ markSeen = true } = {}) {
    const emails = await this.fetchEmails({ markSeen });
    const allItems = [];

    for (const email of emails) {
      if (!email.attachments) continue;
      const senderAddress = email.from?.value?.[0]?.address || '';
      const leverancier = leverancierFromEmail(senderAddress);
      for (const att of email.attachments) {
        if (!att.contentType || !att.contentType.includes('pdf')) continue;
        const items = await this.parsePdfWithClaude(att.content, att.filename);
        allItems.push(...items.map(i => ({ ...i, leverancier: leverancier || i.leverancier || '' })));
      }
    }

    // Dedupliceer op ingredient naam (neem gemiddelde als dubbel)
    const map = {};
    for (const item of allItems) {
      const key = item.ingredient.toLowerCase().trim();
      if (!map[key]) {
        map[key] = { ...item, count: 1 };
      } else {
        map[key].price = (map[key].price * map[key].count + item.price) / (map[key].count + 1);
        map[key].count++;
      }
    }

    return Object.values(map);
  }
}

module.exports = ImapScanner;
