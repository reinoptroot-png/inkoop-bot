#!/usr/bin/env node
// Haalt automatisch een vers Tebi Bearer token op via headless browser.
// Logt in op live.tebi.co, onderschept het eerste API-request, slaat token op.
// Gebruik: node tebi-token-refresh.js
// Cron: vóór tebi-scan.js draaien (bijv. 07:25)

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const SETTINGS = path.join(__dirname, 'settings.json');
const EMAIL    = 'dimitri@europa.rest';
const PASSWORD = 'Euro2023World!';
const LEDGER   = '976290';
const TIMEOUT  = 60000;

async function main() {
  console.log('[tebi-token] Browser starten...');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page    = await context.newPage();

  let token = null;

  // Onderschep alle requests naar de Tebi API
  page.on('request', req => {
    const url = req.url();
    if (url.includes('live.tebi.co/api') || url.includes('auth.tebi.co')) {
      const auth = req.headers()['authorization'];
      if (auth && auth.startsWith('Bearer ') && !token) {
        const t = auth.replace('Bearer ', '').trim();
        // Alleen echte JWT tokens (lang) of Tebi API tokens
        if (t.length > 20) {
          token = t;
          console.log('[tebi-token] Token gevonden via request interceptie');
        }
      }
    }
  });

  try {
    console.log('[tebi-token] Navigeren naar Tebi...');
    await page.goto(`https://live.tebi.co/backoffice/ledgers/${LEDGER}/home`, {
      waitUntil: 'networkidle',
      timeout: TIMEOUT,
    });

    // Controleer of we op de loginpagina zijn
    const url = page.url();
    if (url.includes('auth.tebi.co') || url.includes('login')) {
      console.log('[tebi-token] Loginpagina gevonden, inloggen...');

      await page.fill('input[type="email"], input[name="email"], input[name="username"]', EMAIL, { timeout: 10000 });
      await page.fill('input[type="password"]', PASSWORD, { timeout: 10000 });
      await page.click('button[type="submit"]', { timeout: 10000 });

      await page.waitForURL(`**/ledgers/${LEDGER}/**`, { timeout: TIMEOUT });
      console.log('[tebi-token] Ingelogd.');
    } else {
      console.log('[tebi-token] Al ingelogd.');
    }

    // Als token nog niet onderschept is via navigatie, triggeer een API-call
    if (!token) {
      console.log('[tebi-token] API-call triggeren om token te onderscheppen...');
      // Navigeer naar insights — dit triggert een API-call met Bearer token
      await page.goto(`https://live.tebi.co/backoffice/ledgers/${LEDGER}/insights`, {
        waitUntil: 'networkidle',
        timeout: TIMEOUT,
      });
    }

    // Als nog geen token: haal het uit localStorage/sessionStorage
    if (!token) {
      token = await page.evaluate(() => {
        // Zoek in localStorage en sessionStorage naar tokens
        for (const storage of [localStorage, sessionStorage]) {
          for (let i = 0; i < storage.length; i++) {
            const key = storage.key(i);
            const val = storage.getItem(key);
            if (val && val.length > 50) {
              try {
                const parsed = JSON.parse(val);
                // Auth0 slaat tokens op als object met access_token
                if (parsed.access_token) return parsed.access_token;
                if (parsed.body?.access_token) return parsed.body.access_token;
              } catch {
                // Misschien is het direct een token string
                if (key.toLowerCase().includes('token') || key.toLowerCase().includes('auth')) {
                  return val;
                }
              }
            }
          }
        }
        return null;
      });
      if (token) console.log('[tebi-token] Token gevonden in browser storage');
    }

    if (!token) {
      throw new Error('Geen token gevonden na inloggen');
    }

    // Sla op in settings.json
    let settings = {};
    try { settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch {}
    settings.tebiToken = token;
    fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2));

    console.log('[tebi-token] ✅ Token opgeslagen in settings.json');

  } finally {
    await browser.close();
  }
}

main().catch(e => {
  console.error('[tebi-token] Fout:', e.message);
  process.exit(1);
});
