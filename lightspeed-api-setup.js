#!/usr/bin/env node
// Éénmalige setup: haalt OAuth2 authorization_code op voor de Lightspeed K-Series API.
// Opent de browser-autorisatiepagina, vangt de callback op via een lokale server,
// ruilt de code in voor access_token + refresh_token, slaat op in settings.json + Supabase.
//
// Gebruik:
//   node lightspeed-api-setup.js
//
// Vereiste in settings.json (of env vars):
//   lsClientId, lsClientSecret, lsBusinessLocationId
//
// Na de setup: refresh_token staat in Supabase instellingen (restaurant=europizza, key=ls_refresh_token)
// en kan via de GitHub Actions workflow (lightspeed-api-scan.yml) worden gebruikt.

const http    = require('http');
const https   = require('https');
const path    = require('path');
const fs      = require('fs');
const { createClient } = require('@supabase/supabase-js');

const SETTINGS_FILE = path.join(__dirname, 'settings.json');
let _sf = {};
try { _sf = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch {}

const CLIENT_ID     = _sf.lsClientId     || process.env.LS_CLIENT_ID;
const CLIENT_SECRET = _sf.lsClientSecret || process.env.LS_CLIENT_SECRET;
const REDIRECT_URI  = 'http://localhost:3333/callback';
const PORT          = 3333;

const AUTH_HOST  = 'auth.lsk.lightspeed.app';
const TOKEN_PATH = '/realms/k-series/protocol/openid-connect/token';
const AUTH_URL   =
  `https://${AUTH_HOST}/realms/k-series/protocol/openid-connect/auth` +
  `?client_id=${encodeURIComponent(CLIENT_ID)}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
  `&response_type=code` +
  `&scope=openid`;

const SUPABASE_URL = _sf.supabaseUrl || process.env.SUPABASE_URL;
const SUPABASE_KEY = _sf.supabaseKey || process.env.SUPABASE_KEY;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('[ls-setup] LS_CLIENT_ID en LS_CLIENT_SECRET zijn verplicht.');
  console.error('           Voeg toe aan settings.json als lsClientId / lsClientSecret.');
  process.exit(1);
}

async function exchangeCode(code) {
  const body = new URLSearchParams({
    grant_type:    'authorization_code',
    client_id:     CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri:  REDIRECT_URI,
    code,
  }).toString();

  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: AUTH_HOST, path: TOKEN_PATH, method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded',
                   'Content-Length': Buffer.byteLength(body) } },
      res => {
        let d = '';
        res.on('data', c => { d += c; });
        res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ _raw: d }); } });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function run() {
  console.log('\n=== Lightspeed API Setup ===');
  console.log('Stap 1: Autoriseer de app in de browser.\n');
  console.log('Open deze URL:\n');
  console.log(AUTH_URL);
  console.log('\n(Op Mac: open "' + AUTH_URL + '")');

  // Probeer browser te openen
  try {
    const { execSync } = require('child_process');
    execSync(`open "${AUTH_URL}"`);
  } catch {}

  // Lokale server voor de OAuth callback
  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      const code = url.searchParams.get('code');
      const err  = url.searchParams.get('error');

      if (err) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end(`OAuth fout: ${err} — ${url.searchParams.get('error_description') || ''}`);
        server.close();
        return reject(new Error(`OAuth fout: ${err}`));
      }
      if (code) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body><h2>✅ Geautoriseerd!</h2><p>Je kunt dit venster sluiten.</p></body></html>');
        server.close();
        resolve(code);
      }
    });
    server.listen(PORT, () => console.log(`\nWachten op callback op http://localhost:${PORT}/callback ...`));
    server.on('error', reject);
    setTimeout(() => { server.close(); reject(new Error('Timeout na 5 minuten')); }, 300000);
  });

  console.log('\nStap 2: Code ontvangen, tokens ophalen...');
  const tokens = await exchangeCode(code);

  if (tokens.error) {
    console.error(`\n[ls-setup] Token uitwisseling mislukt: ${tokens.error} — ${tokens.error_description || ''}`);
    process.exit(1);
  }

  const { access_token, refresh_token, expires_in } = tokens;
  console.log(`✅ access_token ontvangen (geldig ${expires_in}s)`);
  console.log(`✅ refresh_token ontvangen`);

  // Opslaan in settings.json
  let sf = {};
  try { sf = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch {}
  sf.lsAccessToken  = access_token;
  sf.lsRefreshToken = refresh_token;
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(sf, null, 2));
  console.log('✅ Tokens opgeslagen in settings.json');

  // Opslaan in Supabase (zodat GitHub Actions ze kan lezen/bijwerken)
  if (SUPABASE_URL && SUPABASE_KEY) {
    const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
    const now = new Date().toISOString();
    await sb.from('instellingen').upsert(
      [
        { restaurant: 'europizza', key: 'ls_refresh_token', value: refresh_token, updated_at: now },
        { restaurant: 'europizza', key: 'ls_access_token',  value: access_token,  updated_at: now },
      ],
      { onConflict: 'restaurant,key' }
    );
    console.log('✅ refresh_token opgeslagen in Supabase instellingen (restaurant=europizza)');
  } else {
    console.warn('⚠️  Supabase credentials ontbreken — sla refresh_token handmatig op in Supabase.');
  }

  console.log('\n=== Setup voltooid ===');
  console.log('De GitHub Actions workflow (lightspeed-api-scan.yml) is nu klaar om te draaien.');
  console.log('Voeg de volgende secrets toe aan de GitHub repo (reinoptroot-png/inkoop-bot):');
  console.log('  LS_CLIENT_ID             =', CLIENT_ID);
  console.log('  LS_CLIENT_SECRET         = (zie settings.json)');
  console.log('  LS_BUSINESS_LOCATION_ID  = (integer ID van de Europizza vestiging — zie Lightspeed backoffice)');
  console.log('  SUPABASE_URL             =', SUPABASE_URL || '(al ingesteld)');
  console.log('  SUPABASE_KEY             = (al ingesteld)');
}

run().catch(e => {
  console.error('\n[ls-setup] Fout:', e.message);
  process.exit(1);
});
