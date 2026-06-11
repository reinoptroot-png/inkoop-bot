const Imap = require('imap');
const { simpleParser } = require('mailparser');
const pdfParse = require('pdf-parse');
const fetch = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');
const { isLightspeedDagrapport, extractCsvLink, parseDagrapport } = require('./lightspeed');

// Strikte whitelist: Supabase `leveranciers` (actief=true) is de ENIGE bron van
// waarheid. Geen hardcoded fallback meer — onbekende afzenders worden genegeerd.
// Bij ontbrekende/onbereikbare Supabase wordt er niets verwerkt (veilig).
async function loadKnownSenders(settings) {
  const url = settings.supabaseUrl || process.env.SUPABASE_URL;
  const key = settings.supabaseKey || process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) {
    console.warn('[scan] ⚠ Supabase niet geconfigureerd — geen leveranciers-whitelist, geen emails verwerkt.');
    return {};
  }
  try {
    const sb = createClient(url, key);
    const { data, error } = await sb.from('leveranciers').select('naam, email').eq('actief', true);
    if (error) {
      console.warn('[scan] ⚠ leveranciers niet geladen:', error.message, '— geen emails verwerkt.');
      return {};
    }
    const map = {};
    for (const row of (data || [])) {
      if (row.email) map[row.email.toLowerCase().trim()] = row.naam;
    }
    if (Object.keys(map).length === 0) {
      console.warn('[scan] ⚠ Geen actieve leveranciers in de whitelist — geen emails verwerkt.');
    }
    return map;
  } catch (e) {
    console.warn('[scan] ⚠ Supabase fout:', e.message, '— geen emails verwerkt.');
    return {};
  }
}

function leverancierFromEmail(address, knownSenders) {
  if (!address) return '';
  const lower = address.toLowerCase();
  if (knownSenders[lower]) return knownSenders[lower];
  const domain = lower.split('@')[1];
  return (domain && knownSenders[domain]) || '';
}

// ── Detectie van nieuwe FOOD-leveranciers ────────────────────────────────────
const INVOICE_RE = /factuur|faktuur|pakbon|invoice|bestelbon|leverbon|vrachtbrief/i;
const SKIP_SUBJECT_RE = /aanmaning|herinnering|betalingsherinnering|offerte|typefout/i;
const PERSOONLIJKE_DOMEINEN = new Set([
  'gmail.com', 'outlook.com', 'outlook.nl', 'hotmail.com', 'hotmail.nl', 'live.nl', 'live.com',
  'icloud.com', 'me.com', 'yahoo.com', 'ziggo.nl', 'kpnmail.nl', 'planet.nl', 'home.nl',
]);
// Geen melding voor telecom, utilities, software/SaaS, financieel, overig non-food
const NON_FOOD_SENDER_RE = /verzekering|\bnn\.nl\b|ziggo|odido|\bkpn\b|vodafone|t-mobile|tele2|\bsim\b|snelstart|jortt|rompslomp|\bvoys\b|\bexact\b|moneybird|easypark|riverty|yellowbrick|parkmobile|belasting|\bkvk\b|essent|eneco|vattenfall|greenchoice|vitens|waternet|\benergie\b|\bgas\b|microsoft|google|adobe|\bapple\b|spotify|hosting|webhosting|domein|drukwerk|reclame|plaatreklame|verhuur|\blease\b|software|telecom|rentokil|hobart|isero|refurbished|quatra|wairtec|bender|etine|snelstart/i;
// Wijn/drank-only leveranciers (geen food) — geen melding
const DRANK_SENDER_RE = /\bwijn\b|\bwine\b|wijnimport|wijnen|\bvins\b|château|chateau|cuvée|cuvee|domaine|vignoble|winestor|bolomey|sommelier|brouwerij|brewery|bierbrouw|distilleer|spirits/i;

function afzenderNaam(parsed) {
  const v = parsed.from?.value?.[0] || {};
  if (v.name && v.name.trim() && !v.name.includes('@')) return v.name.trim();
  const domain = (v.address || '').split('@')[1] || (v.address || '');
  const b = domain.split('.')[0] || domain;
  return b.charAt(0).toUpperCase() + b.slice(1);
}

// Heuristiek: lijkt deze e-mail van een (nog onbekende) FOOD-leverancier?
// factuur/pakbon-achtig, niet persoonlijk, niet telecom/utility/software, niet wijn/drank-only.
function lijktFoodLeverancier(parsed) {
  const addr = (parsed.from?.value?.[0]?.address || '').toLowerCase();
  if (!addr || addr === '(onbekend)') return false;
  const domain = addr.split('@')[1] || '';
  if (PERSOONLIJKE_DOMEINEN.has(domain)) return false;
  const subject = parsed.subject || '';
  if (SKIP_SUBJECT_RE.test(subject)) return false;
  if (!INVOICE_RE.test(subject) && !INVOICE_RE.test(parsed.text || '')) return false;
  const blob = `${parsed.from?.value?.[0]?.name || ''} ${addr} ${subject}`;
  if (NON_FOOD_SENDER_RE.test(blob)) return false;
  if (DRANK_SENDER_RE.test(blob)) return false;
  return true;
}

// Schrijf 'nieuwe_leverancier' meldingen naar Supabase (dedup tegen whitelist + bestaande meldingen)
async function schrijfNieuweLeverancierMeldingen(url, key, kandidaten) {
  if (!url || !key || !kandidaten || kandidaten.length === 0) return 0;
  try {
    const sb = createClient(url, key);
    const { data: levs } = await sb.from('leveranciers').select('email');
    const whitelist = new Set((levs || []).map(l => (l.email || '').toLowerCase().trim()).filter(Boolean));
    const { data: bestaand } = await sb.from('scan_meldingen').select('leverancier').eq('type', 'nieuwe_leverancier');
    const alGemeld = new Set((bestaand || []).map(m => (m.leverancier || '').toLowerCase().trim()).filter(Boolean));
    const isKnown = (e) => {
      const d = e.split('@')[1] || '';
      for (const w of whitelist) { if (e === w || d === w || e.endsWith('@' + w) || (d && d.endsWith(w))) return true; }
      return false;
    };
    let n = 0;
    for (const k of kandidaten) {
      const email = (k.email || '').toLowerCase().trim();
      if (!email || isKnown(email) || alGemeld.has(email)) continue;
      const { error } = await sb.from('scan_meldingen').insert({
        type: 'nieuwe_leverancier', ingredient_naam: k.naam, leverancier: email, status: 'pending', gelezen: false,
      });
      if (!error) { n++; alGemeld.add(email); }
      else console.warn('[nieuwe-lev] schrijffout:', error.message);
    }
    return n;
  } catch (e) { console.warn('[nieuwe-lev] fout:', e.message); return 0; }
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
  {
    "ingredient": "naam van het product", "price": 12.50, "eenheid": "kg",
    "artikelnummer": "...", "barcode": "...", "omschrijving": "...", "gewicht": "...",
    "verpakking": "...", "btw": "...", "factuurnummer": "...", "ordernummer": "...",
    "herkomst": "...", "kwaliteitsklasse": "...", "temperatuur": "...", "min_bestelling": "..."
  },
  ...
]

Regels:
- "ingredient": de productnaam, zo duidelijk mogelijk, in het Nederlands of originele taal
- "price": de prijs per eenheid (per kg, per liter, per stuk), als getal
- "eenheid": de eenheid (kg, liter, stuk, etc.)
- Als de prijs per doos/krat is, bereken dan de prijs per kg/stuk als dat mogelijk is
- Sla producten over waarbij je de eenheidsprijs niet kunt bepalen
- Vul de EXTRA velden (artikelnummer, barcode, omschrijving, gewicht, verpakking, btw, factuurnummer, ordernummer, herkomst/land van herkomst, kwaliteitsklasse, temperatuur, min_bestelling) ALLEEN in als ze daadwerkelijk op de factuur staan; laat een veld weg of zet het op null als het er niet staat. Verzin niets.
- factuurnummer en ordernummer gelden voor de hele factuur — neem ze bij elk item op als ze ergens op de factuur staan.

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
          max_tokens: 8000, // ruim genoeg voor lange facturen met alle extra velden per regel
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
    const knownSenders = await loadKnownSenders(this.settings);
    log(`[scan] ${Object.keys(knownSenders).length} bekende afzenders geladen`);
    const emails = await this.fetchEmails({ markSeen, lookbackDays, reprocess, debug });
    const allItems = [];
    const nieuweLeveranciers = {};
    const dagrapporten = [];

    for (const email of emails) {
      const subject = email.subject || '(geen onderwerp)';
      const senderAddress = email.from?.value?.[0]?.address || '(onbekend)';

      // Lightspeed dagrapport — CSV via downloadlink in de mail (apart van het factuur/whitelist-pad)
      if (isLightspeedDagrapport(email)) {
        const link = extractCsvLink(email);
        if (link) {
          try {
            const resp = await fetch(link);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const csvText = await resp.text();
            const dr = parseDagrapport(csvText);
            dagrapporten.push(dr);
            log(`[scan] Lightspeed dagrapport: ${dr.datum || '?'} — omzet ${dr.totale_omzet ?? '?'}, ${dr.gerechten.length} gerechten`);
          } catch (e) { log(`[scan] dagrapport download/parse-fout: ${e.message}`); }
        } else {
          log(`[scan] Lightspeed-mail zonder CSV-link: "${subject}"`);
        }
        continue;
      }

      // Strikte whitelist: negeer producten van afzenders die niet in Supabase staan.
      // Wél detecteren: lijkt het op een nieuwe food-leverancier? → kandidaat-melding.
      const leverancier = leverancierFromEmail(senderAddress, knownSenders);
      if (!leverancier) {
        if (lijktFoodLeverancier(email)) {
          const e = senderAddress.toLowerCase();
          if (!nieuweLeveranciers[e]) nieuweLeveranciers[e] = { email: e, naam: afzenderNaam(email) };
          log(`[scan] Mogelijke nieuwe food-leverancier: ${senderAddress} ("${subject}")`);
        } else {
          log(`[scan] Genegeerd — niet in whitelist: ${senderAddress} ("${subject}")`);
        }
        continue;
      }
      if (!email.attachments || email.attachments.length === 0) {
        log(`[scan] Overgeslagen — geen bijlagen: "${subject}" van ${senderAddress}`);
        continue;
      }
      log(`[scan] Verwerken: "${subject}" van ${senderAddress} → leverancier="${leverancier}"`);
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
    // Side-channel: nieuwe food-leverancier kandidaten (verandert return-type niet)
    this.nieuweLeveranciers = Object.values(nieuweLeveranciers);
    if (this.nieuweLeveranciers.length) log(`[scan] ${this.nieuweLeveranciers.length} mogelijke nieuwe food-leverancier(s)`);
    this.dagrapporten = dagrapporten;
    if (dagrapporten.length) log(`[scan] ${dagrapporten.length} Lightspeed dagrapport(en)`);
    return result;
  }
}

module.exports = ImapScanner;
module.exports.lijktFoodLeverancier = lijktFoodLeverancier;
module.exports.afzenderNaam = afzenderNaam;
module.exports.schrijfNieuweLeverancierMeldingen = schrijfNieuweLeverancierMeldingen;
