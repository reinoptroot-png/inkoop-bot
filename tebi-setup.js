#!/usr/bin/env node
// Eenmalig setup-script: haalt een Tebi refresh token op via Auth0 PKCE flow.
// Gebruik: node tebi-setup.js
// Wat het doet:
//   1. Start een lokale callback-server op poort 3399
//   2. Opent de browser naar de Tebi login-pagina
//   3. Jij logt in (of bent al ingelogd — dan gaat het automatisch)
//   4. Slaat refresh_token op in settings.json
//   5. Na deze stap draait tebi-scan.js elke dag automatisch

const http     = require('http');
const https    = require('https');
const crypto   = require('crypto');
const fs       = require('fs');
const path     = require('path');
const { exec } = require('child_process');

const CLIENT_ID    = '0tGlVnSFHtEZwttnrsKKFzomyq9AWlyQ';
const AUTH_DOMAIN  = 'auth.tebi.co';
const AUDIENCE     = 'tebi-api';
const SCOPE        = 'openid profile email offline_access';
const REDIRECT_URI = 'http://localhost:3399/callback';
const SETTINGS     = path.join(__dirname, 'settings.json');

// PKCE helpers
function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
function generateVerifier() { return base64url(crypto.randomBytes(32)); }
function generateChallenge(verifier) {
  return base64url(crypto.createHash('sha256').update(verifier).digest());
}

function post(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', d => { data += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ _raw: data, _status: res.statusCode }); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function exchangeCode(code, verifier) {
  const body = new URLSearchParams({
    grant_type:    'authorization_code',
    client_id:     CLIENT_ID,
    code,
    redirect_uri:  REDIRECT_URI,
    code_verifier: verifier,
  }).toString();
  return post({
    hostname: AUTH_DOMAIN,
    path: '/oauth/token',
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
  }, body);
}

async function main() {
  const verifier   = generateVerifier();
  const challenge  = generateChallenge(verifier);
  const state      = base64url(crypto.randomBytes(8));

  const authUrl = `https://${AUTH_DOMAIN}/authorize?` + new URLSearchParams({
    response_type:         'code',
    client_id:             CLIENT_ID,
    redirect_uri:          REDIRECT_URI,
    audience:              AUDIENCE,
    scope:                 SCOPE,
    code_challenge:        challenge,
    code_challenge_method: 'S256',
    state,
  });

  let resolve, reject;
  const done = new Promise((res, rej) => { resolve = res; reject = rej; });

  const server = http.createServer(async (req, res) => {
    if (!req.url.startsWith('/callback')) { res.end(); return; }
    const params = new URL(req.url, 'http://localhost').searchParams;
    if (params.get('error')) {
      res.end(`<h2>Fout: ${params.get('error_description') || params.get('error')}</h2>`);
      reject(new Error(params.get('error_description') || params.get('error')));
      return;
    }
    const code = params.get('code');
    if (!code) { res.end('<h2>Geen code ontvangen.</h2>'); reject(new Error('geen code')); return; }
    res.end('<h2>✅ Tebi token opgeslagen — je kunt dit venster sluiten.</h2>');
    resolve(code);
  });

  server.listen(3399, () => {
    console.log('\n=== Tebi eenmalige setup ===');
    console.log('Browser opent automatisch. Log in op Tebi (of wacht — als je al ingelogd bent gaat het vanzelf).');
    console.log('URL:', authUrl, '\n');
    exec(`open "${authUrl}"`);
  });

  const code = await done.catch(e => { server.close(); throw e; });
  server.close();

  console.log('Code ontvangen, token ophalen...');
  const tokens = await exchangeCode(code, verifier);

  if (tokens.error) {
    console.error('Token fout:', tokens.error, tokens.error_description);
    process.exit(1);
  }
  if (!tokens.refresh_token) {
    console.error('Geen refresh_token ontvangen. Response:', JSON.stringify(tokens, null, 2));
    process.exit(1);
  }

  // Sla op in settings.json
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch {}
  settings.tebiToken        = tokens.access_token;
  settings.tebiRefreshToken = tokens.refresh_token;
  fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2));

  console.log('✅ refresh_token opgeslagen in settings.json');
  console.log('   tebi-scan.js vernieuwt voortaan automatisch de token — niets meer handmatig.');
}

main().catch(e => { console.error('Fout:', e.message); process.exit(1); });
