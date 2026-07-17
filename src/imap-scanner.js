const Imap = require('imap');
const { simpleParser } = require('mailparser');
const pdfParse = require('pdf-parse');
const fetch = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');
const { isLightspeedDagrapport, extractCsvLink, parseDagrapport } = require('./lightspeed');
const { verwerkClaudeTekst } = require('./factuur-parse');

// ── Dedup op verwerkte e-mails (Supabase) ─────────────────────────────────────
// Vervangt het broze "alleen UNSEEN"-mechanisme: we onthouden welke mails al
// verwerkt zijn (message-id), zodat een ruimer venster geen dubbele Claude-calls
// geeft, en in Mail geopende mails tóch verwerkt worden.
function sbClient(settings) {
  const url = settings.supabaseUrl || process.env.SUPABASE_URL;
  const key = settings.supabaseKey || process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY;
  return (url && key) ? createClient(url, key) : null;
}
function emailKey(email) {
  if (email.messageId) return String(email.messageId).trim();
  const from = email.from?.value?.[0]?.address || '?';
  const dt = email.date ? new Date(email.date).toISOString().slice(0, 10) : '?';
  return `${from}|${email.subject || '?'}|${dt}`;
}
async function loadVerwerkteEmails(settings) {
  const sb = sbClient(settings);
  if (!sb) return new Set();
  try {
    const { data } = await sb.from('verwerkte_emails').select('email_key');
    return new Set((data || []).map(r => r.email_key));
  } catch { return new Set(); }
}
async function markEmailVerwerkt(settings, key, meta = {}) {
  const sb = sbClient(settings);
  if (!sb) return;
  try {
    await sb.from('verwerkte_emails').upsert({
      email_key: key, leverancier: meta.leverancier || null, onderwerp: meta.onderwerp || null,
      email_datum: meta.email_datum || null, producten: meta.producten || 0, verwerkt_op: new Date().toISOString(),
    }, { onConflict: 'email_key' });
  } catch {}
}

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

// Trust-all mailboxen: gecureerde leverancier-dropboxen waar de afzender-whitelist niet geldt.
// Default: pakbon@europa.rest. Overschrijfbaar via TRUSTALL_MAILBOXES (komma-gescheiden);
// leeg gezet ('') = geen enkele trust-all mailbox. Puur → testbaar (test-import-fixes.js).
function trustAllMailboxen(env = process.env.TRUSTALL_MAILBOXES) {
  const bron = env == null ? 'pakbon@europa.rest' : env;
  return String(bron).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}
function isTrustAllMailbox(imapUser, env) {
  return trustAllMailboxen(env).includes(String(imapUser || '').toLowerCase());
}

// F-08 (bindend besluit 16 juli 2026): dedup op ingredientnaam waarbij de LAATSTE (meest recente)
// factuurprijs wint — nooit een gemiddelde. Vergelijk op factuurdatum (ISO YYYY-MM-DD, lexicografisch
// = chronologisch); zonder bruikbare datum wint de later-verwerkte vermelding. Nooit leveranciers
// samenvoegen (dat brak de artikelnr-index). Puur → testbaar (test-import-fixes.js). Gedeeld door
// de per-mailbox-dedup (scan hieronder) én de cross-mailbox-dedup in scan.js.
function dedupLaatstePrijs(items) {
  const map = {};
  for (const item of items || []) {
    const key = (item.ingredient || '').toLowerCase().trim();
    if (!key) continue;
    const bestaand = map[key];
    if (!bestaand || (item.factuurdatum || '') >= (bestaand.factuurdatum || '')) {
      map[key] = { ...item, ingredient: key };
    }
  }
  return Object.values(map);
}

// Claude-fout die het waard is om opnieuw te proberen: rate limit (429), overbelast (529),
// serverfout (5xx) of het bijbehorende error.type. Een 4xx als 400 (invalid_request) is
// persistent → niet opnieuw proberen. Puur → testbaar.
function isTransienteFout(httpStatus, errorType) {
  if (httpStatus === 429 || httpStatus === 529 || (httpStatus >= 500 && httpStatus <= 599)) return true;
  return ['rate_limit_error', 'overloaded_error', 'api_error'].includes(errorType || '');
}
// Wachttijd vóór de volgende poging: respecteer de Retry-After-header (seconden), anders
// exponentieel (2^poging s) met een plafond zodat we niet door de mailbox-timeout heen lopen.
function backoffMs(poging, retryAfter) {
  const ra = parseInt(retryAfter, 10);
  if (Number.isFinite(ra) && ra > 0) return Math.min(ra * 1000, 30000);
  return Math.min(2 ** poging * 1000, 20000);
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Leverancier afleiden uit de mailcontext als noch de whitelist noch het document er een geeft
// (trust-all pakbonnen). Onderwerp "Uw pakbon van Fix Fisch BV" → "Fix Fisch"; anders de
// afzendernaam. Zo krijgt elke rij/melding een herkenbare bron i.p.v. leeg. Puur → testbaar.
function leverancierUitContext(subject, afzenderNaamStr) {
  const m = (subject || '').match(/\bvan\s+(.+?)(?:\s+b\.?\s?v\.?)?\s*$/i);
  if (m && m[1].trim().length >= 3) return m[1].trim();
  return (afzenderNaamStr || '').trim();
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

// Datum → YYYY-MM-DD (of null bij ongeldige datum).
function ymdDate(d) {
  try { const z = new Date(d); return isNaN(z) ? null : z.toISOString().split('T')[0]; } catch { return null; }
}

// Bouw per factuur één totaalrij uit de losse factuurregels (vóór de dedup op
// productnaam, anders zijn de regelbedragen al weg). Per factuurnr: totaalbedrag
// = het expliciete factuurtotaal als dat op de factuur stond (incl. btw), anders
// de som van de netto regelbedragen (excl. btw). Het btw_inclusief-vlag labelt
// welke van de twee het is. Retourneert rijen klaar voor upsert op factuurnr.
function aggregeerFacturen(regels) {
  const map = {};
  for (const r of (regels || [])) {
    const fnr = String(r.factuurnummer || '').trim();
    if (!fnr) continue;
    if (!map[fnr]) map[fnr] = { factuurnr: fnr, leverancier: r.leverancier || '', factuurdatum: r.factuurdatum || r.emailDatum || null, regelsom: 0, aantal_regels: 0, factuurtotaal: null };
    const f = map[fnr];
    const rb = Number(r.regelbedrag);
    if (isFinite(rb) && rb > 0) f.regelsom += rb;
    f.aantal_regels++;
    if (!f.factuurdatum && (r.factuurdatum || r.emailDatum)) f.factuurdatum = r.factuurdatum || r.emailDatum;
    if (!f.leverancier && r.leverancier) f.leverancier = r.leverancier;
    const ft = Number(r.factuurtotaal);
    if (isFinite(ft) && ft > 0) f.factuurtotaal = ft;
  }
  return Object.values(map).map(f => {
    const directTotal = f.factuurtotaal != null;
    const totaal = directTotal ? f.factuurtotaal : (f.regelsom > 0 ? Math.round(f.regelsom * 100) / 100 : null);
    return {
      factuurnr: f.factuurnr,
      leverancier: f.leverancier || null,
      factuurdatum: f.factuurdatum || null,
      totaalbedrag: totaal,
      btw_inclusief: directTotal,
      aantal_regels: f.aantal_regels,
      valuta: 'EUR',
    };
  }).filter(r => r.totaalbedrag != null);
}

class ImapScanner {
  constructor(settings) {
    this.settings = settings;
  }

  fetchEmails({ markSeen = false, lookbackDays = 45, reprocess = false, debug = false } = {}) {
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
        tlsOptions: { rejectUnauthorized: false },
        connTimeout: 20000,
        authTimeout: 10000,
      });

      const since = new Date();
      since.setDate(since.getDate() - lookbackDays);
      // Dedup gebeurt nu op message-id (verwerkte_emails), niet op de IMAP-gelezen-vlag.
      const criteria = [['SINCE', since]];
      log(`[imap] Criteria: alle emails sinds ${since.toISOString().split('T')[0]} (lookbackDays=${lookbackDays}); dedup via verwerkte_emails`);

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
      // F-01: retrybaar (ok:false) — een kapotte read kan aan ons liggen; markeer de mail niet.
      log(`[pdf] pdf-parse mislukt: ${e.message}`);
      return { ok: false, items: [] };
    }

    if (!text || text.trim().length < 50) {
      // Deterministisch leeg (scan-/beeld-PDF): een nieuwe run geeft hetzelfde ⇒ geslaagd, 0 items.
      log(`[pdf] Overgeslagen — te weinig tekst (${text.trim().length} tekens)`);
      return { ok: true, items: [] };
    }

    const prompt = `Je bent een assistent die leveranciersfacturen analyseert voor een restaurant.

Hieronder staat de tekst van een factuur of pakbon. Extraheer alle ingrediënten/producten met hun inkoopprijs.

Retourneer ALLEEN een JSON array, geen uitleg, geen markdown backticks. Formaat:
[
  {
    "ingredient": "naam van het product", "price": 12.50, "eenheid": "kg", "regelbedrag": 37.50,
    "artikelnummer": "...", "barcode": "...", "omschrijving": "...", "gewicht": "...",
    "verpakking": "...", "btw": "...", "factuurnummer": "...", "ordernummer": "...",
    "factuurdatum": "2026-06-11", "factuurtotaal": 412.83,
    "herkomst": "...", "kwaliteitsklasse": "...", "temperatuur": "...", "min_bestelling": "..."
  },
  ...
]

Regels:
- "ingredient": de productnaam, zo duidelijk mogelijk, in het Nederlands of originele taal
- "price": de prijs per eenheid (per kg, per liter, per stuk), als getal, ALTIJD EXCL. BTW (netto). Toont de factuur alleen bruto regelprijzen (incl. btw), reken terug naar excl. (voedsel 9%, non-food 21%); kan dat niet betrouwbaar, sla het product dan over.
- "eenheid": de eenheid (kg, liter, stuk, etc.)
- Als de prijs per doos/krat is, bereken dan de prijs per kg/stuk als dat mogelijk is
- Bevat een regel een AANTAL stuks (bv. "24 stuks", "25 stuks", "doos 48") en is het bedrag voor de hele verpakking, geef dan ALTIJD de prijs PER ÉÉN stuk (bedrag ÷ aantal), met eenheid "stuk". Wees hierin consistent: nooit de verpakkingsprijs als stuksprijs opgeven. Zet het aantal niet in de "ingredient"-naam.
- "regelbedrag": het TOTALE bedrag van die factuurregel zoals op de factuur staat (aantal × stukprijs, excl. btw indien de factuur netto regelbedragen toont), als getal. Null als je het niet kunt bepalen.
- Sla producten over waarbij je de eenheidsprijs niet kunt bepalen
- Vul de EXTRA velden (artikelnummer, barcode, omschrijving, gewicht, verpakking, btw, factuurnummer, ordernummer, herkomst/land van herkomst, kwaliteitsklasse, temperatuur, min_bestelling) ALLEEN in als ze daadwerkelijk op de factuur staan; laat een veld weg of zet het op null als het er niet staat. Verzin niets.
- factuurnummer, ordernummer, factuurdatum en factuurtotaal gelden voor de hele factuur — neem ze bij elk item op als ze ergens op de factuur staan.
- "factuurdatum": de factuurdatum in formaat YYYY-MM-DD. Null als niet zichtbaar.
- "factuurtotaal": het EINDtotaal van de hele factuur (het te betalen bedrag) als getal, als dat expliciet op de factuur staat. Null als er geen eindtotaal staat.

Factuur tekst:
${text.substring(0, 24000)}`;

    const body = JSON.stringify({
      model: 'claude-opus-4-5',
      max_tokens: 16000, // 8000 kapte lange facturen (>~40 regels) halverwege af; 16000 blijft onder de non-streaming HTTP-timeout
      messages: [{ role: 'user', content: prompt }],
    });
    // Bounded retry-met-backoff op transiente fouten (rate limit/overbelast/serverfout). Zonder dit
    // faalde bij een backlog-catch-up (tientallen PDF's snel achter elkaar) het merendeel op 429 en
    // bleven de pakbonnen — dankzij F-01 wél retrybaar — steken tot een volgende run. Fouten gaan
    // via console.warn (niet het onderdrukte log()) zodat de reden altijd zichtbaar is.
    const MAX_POGINGEN = 3;
    for (let poging = 1; poging <= MAX_POGINGEN; poging++) {
      try {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': this.settings.anthropicKey,
            'anthropic-version': '2023-06-01',
          },
          body,
        });
        if (isTransienteFout(response.status)) {
          if (poging < MAX_POGINGEN) {
            const wacht = backoffMs(poging, response.headers.get('retry-after'));
            console.warn(`[pdf] Claude ${response.status} (rate limit/overbelast) voor "${filename}" — poging ${poging}/${MAX_POGINGEN}, ${Math.round(wacht / 1000)}s wachten`);
            await sleep(wacht);
            continue;
          }
          console.warn(`[pdf] Claude bleef ${response.status} geven voor "${filename}" na ${MAX_POGINGEN} pogingen — mail blijft retrybaar`);
          return { ok: false, items: [] };
        }
        const data = await response.json();
        if (data.error) {
          // F-01: API-storing is retrybaar — mail NIET markeren. Transient? even wachten en opnieuw.
          if (isTransienteFout(null, data.error.type) && poging < MAX_POGINGEN) {
            const wacht = backoffMs(poging, null);
            console.warn(`[pdf] Claude ${data.error.type} voor "${filename}" — poging ${poging}/${MAX_POGINGEN}, ${Math.round(wacht / 1000)}s wachten`);
            await sleep(wacht);
            continue;
          }
          console.warn(`[pdf] Claude API fout (${filename}): ${data.error.message} — mail blijft retrybaar`);
          return { ok: false, items: [] };
        }
        // F-01: fout ≠ leeg — afgekapte JSON of niet-array is ok:false (retry), een geldige
        // lege lijst is ok:true. Pure verwerking + validatie in src/factuur-parse.js (getest).
        const parse = verwerkClaudeTekst(data.content?.[0]?.text || '');
        if (!parse.ok) {
          console.warn(`[pdf] ${parse.fout} voor "${filename}" — mail blijft retrybaar`);
          return parse;
        }
        if (parse.overgeslagen > 0) {
          console.warn(`[pdf] ${parse.overgeslagen} items overgeslagen wegens ontbrekende velden in "${filename}"`);
        }
        log(`[pdf] Claude extraheerde ${parse.items.length} geldige producten uit "${filename}"`);
        return parse;
      } catch (e) {
        // Netwerkfout is ook transient.
        if (poging < MAX_POGINGEN) {
          const wacht = backoffMs(poging, null);
          console.warn(`[pdf] netwerkfout voor "${filename}" (${e.message}) — poging ${poging}/${MAX_POGINGEN}, ${Math.round(wacht / 1000)}s wachten`);
          await sleep(wacht);
          continue;
        }
        console.warn(`[pdf] Claude onbereikbaar voor "${filename}" na ${MAX_POGINGEN} pogingen: ${e.message} — mail blijft retrybaar`);
        return { ok: false, items: [] };
      }
    }
    return { ok: false, items: [] };
  }

  async scan({ markSeen = false, lookbackDays = 45, reprocess = false, debug = false, dryRun = false } = {}) {
    const log = debug ? (...a) => console.log(...a) : () => {};
    const knownSenders = await loadKnownSenders(this.settings);
    log(`[scan] ${Object.keys(knownSenders).length} bekende afzenders geladen`);
    // Trust-all mailbox (bv. pakbon@europa.rest): een gecureerde leverancier-dropbox waar élke
    // afzender een echte leverancier is. Daar vervalt de afzender-whitelist — anders vielen
    // pakbonnen van niet-gewhiteliste afzenders (Fix Fisch via "Leon van der Plas", de Sligro-
    // emballagebon) stil weg. De leverancier komt dan uit het document zelf; de non-food/drank-
    // blacklist, parser-validatie en sanity-poort blijven de troep-filters.
    const trustAll = isTrustAllMailbox(this.settings.imapUser);
    if (trustAll) log(`[scan] trust-all mailbox "${this.settings.imapUser}" — elke PDF wordt verwerkt, leverancier uit het document`);
    const emails = await this.fetchEmails({ markSeen, lookbackDays, reprocess, debug });
    // Al verwerkte mails overslaan (tenzij --reprocess). Bespaart Claude-calls én
    // vangt mails die je elders al opende (gelezen-vlag doet er niet meer toe).
    const verwerkt = reprocess ? new Set() : await loadVerwerkteEmails(this.settings);
    if (!reprocess) log(`[scan] ${verwerkt.size} eerder verwerkte mails bekend`);
    const allItems = [];
    const factuurRegels = []; // losse regels (vóór dedup) voor de factuurtotalen
    const nieuweLeveranciers = {};
    const dagrapporten = [];

    for (const email of emails) {
      const subject = email.subject || '(geen onderwerp)';
      const senderAddress = email.from?.value?.[0]?.address || '(onbekend)';
      const eKey = emailKey(email);
      if (verwerkt.has(eKey)) { log(`[scan] Al verwerkt — overslaan: "${subject}"`); continue; }

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
            if (!reprocess && !dryRun) await markEmailVerwerkt(this.settings, eKey, { leverancier: 'lightspeed', onderwerp: subject, email_datum: ymdDate(email.date) });
          } catch (e) { log(`[scan] dagrapport download/parse-fout: ${e.message}`); }
        } else {
          log(`[scan] Lightspeed-mail zonder CSV-link: "${subject}"`);
        }
        continue;
      }

      // Strikte whitelist: negeer producten van afzenders die niet in Supabase staan.
      // Wél detecteren: lijkt het op een nieuwe food-leverancier? → kandidaat-melding.
      const leverancier = leverancierFromEmail(senderAddress, knownSenders);
      // Trust-all mailbox slaat de whitelist-poort over: onbekende afzender ⇒ tóch verwerken
      // (leverancier komt straks uit het document via `leverancier || i.leverancier`).
      if (!leverancier && !trustAll) {
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
      log(`[scan] Verwerken: "${subject}" van ${senderAddress} → leverancier="${leverancier || '(uit document)'}"`);
      // Trust-all pakbonnen komen van niet-gewhiteliste afzenders, dus `leverancier` is hier leeg;
      // valt Claude's document-leverancier ook weg, dan leidt deze fallback 'm uit het onderwerp af
      // ("Uw pakbon van Fix Fisch BV" → "Fix Fisch") of de afzendernaam — zodat elke rij/melding
      // tóch een herkenbare leverancier krijgt i.p.v. leeg.
      const leverancierFallback = leverancierUitContext(subject, afzenderNaam(email));
      let emailProducten = 0;
      let emailFout = false;   // F-01: één mislukte bijlage-parse houdt de mail retrybaar
      for (const att of email.attachments) {
        if (!att.contentType || !att.contentType.includes('pdf')) {
          log(`[scan] Bijlage overgeslagen — geen PDF (${att.contentType || 'onbekend type'}): "${att.filename}"`);
          continue;
        }
        const parse = await this.parsePdfWithClaude(att.content, att.filename, debug);
        if (!parse.ok) emailFout = true;   // F-01: mislukte parse ⇒ mail niet markeren (retry)
        const items = parse.items;
        log(`[scan] "${att.filename}" → ${items.length} producten gevonden${parse.ok ? '' : ' (PARSE-FOUT — retry volgende run)'}`);
        emailProducten += items.length;
        allItems.push(...items.map(i => ({ ...i, leverancier: leverancier || i.leverancier || leverancierFallback, leverancier_email: senderAddress })));
        // Factuurregels apart bewaren (vóór dedup) voor de factuurtotalen
        for (const i of items) factuurRegels.push({
          factuurnummer: i.factuurnummer, regelbedrag: i.regelbedrag, factuurtotaal: i.factuurtotaal,
          factuurdatum: i.factuurdatum, leverancier: leverancier || i.leverancier || leverancierFallback, emailDatum: ymdDate(email.date),
        });
      }
      // Mail als verwerkt vastleggen — volgende run slaat 'm over (geen dubbele Claude-calls).
      // F-01: ALLEEN bij een geslaagde parse van alle PDF-bijlagen. Vroeger werd hier altijd
      // gemarkeerd, ook als Claude een storing had — die factuur was dan voorgoed kwijt.
      if (emailFout) {
        console.warn(`[scan] "${subject}" (${leverancier}) NÍET als verwerkt gemarkeerd — parse-fout, volgende run opnieuw`);
      } else if (!reprocess && !dryRun) {
        // dryRun mag NIETS naar het ledger schrijven — anders markeert een dry-run de mails als
        // verwerkt en slaat de échte run ze over (waardoor de pakbonnen stil niet ingelezen werden).
        await markEmailVerwerkt(this.settings, eKey, { leverancier, onderwerp: subject, email_datum: ymdDate(email.date), producten: emailProducten });
      }
    }

    log(`[scan] Totaal voor deduplicatie: ${allItems.length} items`);

    // Dedup: laatste factuurprijs wint (F-08) — gedeelde pure functie, geen middeling meer.
    const result = dedupLaatstePrijs(allItems);
    log(`[scan] Na deduplicatie: ${result.length} unieke producten (laatste prijs wint)`);
    // Side-channel: nieuwe food-leverancier kandidaten (verandert return-type niet)
    this.nieuweLeveranciers = Object.values(nieuweLeveranciers);
    if (this.nieuweLeveranciers.length) log(`[scan] ${this.nieuweLeveranciers.length} mogelijke nieuwe food-leverancier(s)`);
    this.dagrapporten = dagrapporten;
    if (dagrapporten.length) log(`[scan] ${dagrapporten.length} Lightspeed dagrapport(en)`);
    // Factuurtotalen (één rij per factuurnr) — side-channel voor inkoop_facturen
    this.facturen = aggregeerFacturen(factuurRegels);
    if (this.facturen.length) log(`[scan] ${this.facturen.length} factuur(totalen) berekend`);
    return result;
  }
}

module.exports = ImapScanner;
module.exports.lijktFoodLeverancier = lijktFoodLeverancier;
module.exports.afzenderNaam = afzenderNaam;
module.exports.schrijfNieuweLeverancierMeldingen = schrijfNieuweLeverancierMeldingen;
module.exports.aggregeerFacturen = aggregeerFacturen;
module.exports.trustAllMailboxen = trustAllMailboxen;
module.exports.isTrustAllMailbox = isTrustAllMailbox;
module.exports.dedupLaatstePrijs = dedupLaatstePrijs;
module.exports.isTransienteFout = isTransienteFout;
module.exports.backoffMs = backoffMs;
module.exports.leverancierUitContext = leverancierUitContext;
