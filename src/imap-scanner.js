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

  fetchEmails({ markSeen = true, lookbackDays = 7, reprocess = false, debug = false } = {}) {
    const log = debug ? (...a) => console.log(...a) : () => {};
    const user = this.settings.imapUser;

    return new Promise((resolve, reject) => {
      log(`[imap] Verbinden met ${this.settings.imapHost || 'imap.one.com'} als ${user} …`);
      const imap = new Imap({
        user,
        password: this.settings.imapPass,
        host: this.settings.imapHost || 'imap.one.com',
        port: 993,
        tls: true,
        tlsOptions: { rejectUnauthorized: false }
      });

      const since = new Date();
      since.setDate(since.getDate() - lookbackDays);
      const criteria = reprocess
        ? [['SINCE', since]]
        : [['SINCE', since], 'UNSEEN'];
      log(`[imap] Criteria: ${reprocess ? 'alle' : 'ongelezen'} emails sinds ${since.toISOString().split('T')[0]} (lookbackDays=${lookbackDays})`);

      imap.once('ready', () => {
        log(`[imap] Verbinding OK — ${user}`);
        imap.openBox('INBOX', false, (err, box) => {
          if (err) return reject(err);
          log(`[imap] Inbox geopend — ${box.messages.total} emails totaal, ${box.messages.unseen ?? '?'} ongelezen`);

          imap.search(criteria, (err, results) => {
            if (err) return reject(err);
            log(`[imap] Zoekopdracht: ${results ? results.length : 0} emails gevonden`);
            if (!results || results.length === 0) {
              imap.end();
              return resolve([]);
            }

            const fetch = imap.fetch(results, { bodies: '', markSeen });
            const promises = [];
            let msgIndex = 0;

            fetch.on('message', (msg) => {
              const idx = ++msgIndex;
              const p = new Promise((res) => {
                msg.on('body', (stream) => {
                  simpleParser(stream, (err, parsed) => {
                    if (err) {
                      log(`[imap] Email #${idx}: parse-fout — ${err.message}`);
                      return res(null);
                    }
                    const from = parsed.from?.value?.[0]?.address || '(onbekend)';
                    const subject = parsed.subject || '(geen onderwerp)';
                    const attCount = parsed.attachments?.length || 0;
                    log(`[imap] Email #${idx}: van=${from} | onderwerp="${subject}" | bijlagen=${attCount}`);
                    res(parsed);
                  });
                });
              });
              promises.push(p);
            });

            fetch.once('end', async () => {
              const parsed = await Promise.all(promises);
              const valid = parsed.filter(Boolean);
              log(`[imap] Fetch klaar — ${valid.length}/${promises.length} emails succesvol geparsed`);
              imap.end();
              resolve(valid);
            });
          });
        });
      });

      imap.once('error', (err) => {
        log(`[imap] Verbinding MISLUKT — ${user}: ${err.message}`);
        reject(err);
      });
      imap.connect();
    });
  }

  async parsePdfWithClaude(pdfBuffer, filename, debug = false) {
    const log = debug ? (...a) => console.log(...a) : () => {};
    log(`[pdf] Verwerken: "${filename}" (${Math.round(pdfBuffer.length / 1024)} KB)`);

    let text = '';
    try {
      const data = await pdfParse(pdfBuffer);
      text = data.text;
      log(`[pdf] Tekst geëxtraheerd: ${text.trim().length} tekens, ${data.numpages} pagina('s)`);
    } catch (e) {
      log(`[pdf] pdf-parse mislukt: ${e.message}`);
      return [];
    }

    if (!text || text.trim().length < 50) {
      log(`[pdf] Overgeslagen — te weinig tekst (${text.trim().length} tekens)`);
      return [];
    }

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
      if (data.error) {
        log(`[pdf] Claude API fout: ${data.error.message}`);
        return [];
      }
      const raw = data.content?.[0]?.text || '';
      const clean = raw.replace(/```json|```/g, '').trim();
      let items;
      try {
        items = JSON.parse(clean);
      } catch (parseErr) {
        console.error(`[pdf] JSON parse mislukt voor "${filename}": ${parseErr.message}`);
        console.error(`[pdf] Claude response was: ${clean.substring(0, 200)}`);
        return [];
      }
      if (!Array.isArray(items)) {
        console.error(`[pdf] Claude gaf geen array terug voor "${filename}": ${typeof items}`);
        return [];
      }
      const valid = items.filter(item => {
        if (!item.ingredient || typeof item.ingredient !== 'string') {
          console.warn(`[pdf] Item zonder ingredient naam overgeslagen:`, JSON.stringify(item));
          return false;
        }
        if (item.price == null || typeof item.price !== 'number' || isNaN(item.price)) {
          console.warn(`[pdf] "${item.ingredient}" overgeslagen — ongeldige prijs:`, item.price);
          return false;
        }
        return true;
      });
      if (valid.length < items.length) {
        console.warn(`[pdf] ${items.length - valid.length} items overgeslagen wegens ontbrekende velden in "${filename}"`);
      }
      log(`[pdf] Claude extraheerde ${valid.length} geldige producten uit "${filename}" (${items.length} totaal)`);
      return valid;
    } catch (e) {
      console.error(`[pdf] Claude parse error (${filename}):`, e.message);
      return [];
    }
  }

  async scan({ markSeen = true, lookbackDays = 7, reprocess = false, debug = false } = {}) {
    const log = debug ? (...a) => console.log(...a) : () => {};
    const emails = await this.fetchEmails({ markSeen, lookbackDays, reprocess, debug });
    const allItems = [];

    for (const email of emails) {
      const subject = email.subject || '(geen onderwerp)';
      const senderAddress = email.from?.value?.[0]?.address || '(onbekend)';
      if (!email.attachments || email.attachments.length === 0) {
        log(`[scan] Overgeslagen — geen bijlagen: "${subject}" van ${senderAddress}`);
        continue;
      }
      const leverancier = leverancierFromEmail(senderAddress);
      log(`[scan] Verwerken: "${subject}" van ${senderAddress} → leverancier="${leverancier || '(onbekend)'}"`);
      for (const att of email.attachments) {
        if (!att.contentType || !att.contentType.includes('pdf')) {
          log(`[scan] Bijlage overgeslagen — geen PDF (${att.contentType || 'onbekend type'}): "${att.filename}"`);
          continue;
        }
        const items = await this.parsePdfWithClaude(att.content, att.filename, debug);
        log(`[scan] "${att.filename}" → ${items.length} producten gevonden`);
        allItems.push(...items.map(i => ({ ...i, leverancier: leverancier || i.leverancier || '' })));
      }
    }

    log(`[scan] Totaal voor deduplicatie: ${allItems.length} items`);

    // Dedupliceer op ingredient naam (neem gemiddelde als dubbel)
    const map = {};
    for (const item of allItems) {
      const key = item.ingredient.toLowerCase().trim();
      if (!map[key]) {
        map[key] = { ...item, count: 1 };
      } else {
        map[key].price = (map[key].price * map[key].count + item.price) / (map[key].count + 1);
        map[key].count++;
        log(`[scan] Dedup: "${key}" — prijs gemiddeld over ${map[key].count} vermeldingen`);
      }
    }

    const result = Object.values(map);
    log(`[scan] Na deduplicatie: ${result.length} unieke producten`);
    return result;
  }
}

module.exports = ImapScanner;
