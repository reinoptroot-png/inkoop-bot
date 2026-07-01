#!/usr/bin/env node
// Vernieuwt de Lightspeed (PosiOS) sessie-token via een headless login.
// PosiOS heeft geen OAuth refresh_token; de backoffice logt in via Lightspeed ID
// (id.lightspeed.app, OIDC) en krijgt daarna een sessie-`apitoken`. Dit script
// rijdt die login na met Playwright, leest de apitoken uit sessionStorage en
// schrijft 'm naar Supabase instellingen (restaurant=europizza, key=ls_pos_token).
// De scan (lightspeed-posios-scan.js) leest die token daar als fallback.
//
// Vereist (env of settings.json): LS_POS_USER, LS_POS_PASS, SUPABASE_URL, SUPABASE_KEY.
// Draai vóór de scan: node lightspeed-posios-login.js
//
// Cron/CI: in de GitHub Actions workflow vóór de scan-stap.

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

let _sf = {};
try { _sf = JSON.parse(fs.readFileSync(path.join(__dirname, 'settings.json'), 'utf8')); } catch {}

const USER = process.env.LS_POS_USER || _sf.lsPosUser;
const PASS = process.env.LS_POS_PASS || _sf.lsPosPass;
const SUPABASE_URL = _sf.supabaseUrl || process.env.SUPABASE_URL;
const SUPABASE_KEY = _sf.supabaseKey || process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY;
const ENTRY = 'https://euc2-web.posios.com/management/en-US/';
const TIMEOUT = 60000;

async function main() {
  // Lightspeed ID is beschermd met Cloudflare Turnstile (anti-bot). De submit-knop
  // blijft disabled tot Turnstile een token geeft — dat lukt niet headless. Draai
  // dit script daarom HEADED op een echte Mac (LS_HEADED=1): jij lost Turnstile +
  // login zelf op, het script pakt daarna de verse token en zet 'm in de secrets.
  const HEADED = !!process.env.LS_HEADED;
  if (!HEADED && (!USER || !PASS)) { console.error('[ls-login] LS_POS_USER / LS_POS_PASS ontbreken'); process.exit(1); }
  console.log(`[ls-login] Browser starten (${HEADED ? 'headed — los login/Turnstile zelf op' : 'headless'})...`);
  const browser = await chromium.launch({ headless: !HEADED, args: ['--disable-blink-features=AutomationControlled'] });
  const context = await browser.newContext();
  const page = await context.newPage();

  // Diagnose: leg de status van de login-POST(s) vast (200 redirect / 401 fout / 403 block).
  page.on('response', res => {
    try {
      const u = res.url();
      if (/id\.lightspeed\.app\/login|sso\/oidc|ls-discovery/i.test(u)) {
        console.log(`[ls-login][net] ${res.status()} ${res.request().method()} ${u.split('?')[0]}`);
      }
    } catch {}
  });

  let token = null;
  try {
    // Backoffice openen → redirect naar Lightspeed ID login (geen sessie in verse context).
    await page.goto(ENTRY, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await page.waitForURL('**id.lightspeed.app/**', { timeout: TIMEOUT });
    const uSel = '#username, input[name="username"]';
    const pSel = '#password, input[name="password"]';

    if (HEADED) {
      console.log('[ls-login] ➜ Log nu IN HET GEOPENDE VENSTER in (vul je gegevens, los Turnstile op, klik Log in).');
      console.log('[ls-login]   Ik wacht max 5 minuten tot je in de backoffice bent...');
    } else {
      // Headless poging (werkt NIET zolang Cloudflare Turnstile actief is — de
      // submit-knop blijft disabled tot er een cf-turnstile-response token is).
      console.log('[ls-login] Loginpagina — invullen (let op: Turnstile blokkeert headless login)...');
      await page.waitForSelector(uSel, { state: 'visible', timeout: 15000 });
      await page.locator(uSel).first().click();
      await page.locator(uSel).first().pressSequentially(USER, { delay: 30 });
      await page.keyboard.press('Tab');
      await page.locator(pSel).first().click();
      await page.locator(pSel).first().pressSequentially(PASS, { delay: 30 });
      await page.keyboard.press('Tab');
      try {
        await page.waitForSelector('button[type="submit"]:not([disabled])', { timeout: 10000 });
        await page.click('button[type="submit"]');
      } catch {
        const turnstile = await page.$('input[name="cf-turnstile-response"]');
        const val = turnstile ? await turnstile.inputValue().catch(() => '') : null;
        if (turnstile && !val) {
          console.error('[ls-login] Submit-knop bleef disabled door Cloudflare Turnstile (anti-bot). Headless login is niet mogelijk; draai met LS_HEADED=1 op een echte Mac.');
        }
        await page.locator(pSel).first().press('Enter');
      }
    }

    // Wachten tot we (na succesvolle login) in de backoffice zijn; daar verschijnt
    // de sessie-apitoken in sessionStorage. Headed: ruim de tijd voor handmatige login.
    const wachtMs = HEADED ? 5 * 60 * 1000 : TIMEOUT;
    try {
      await page.waitForURL('**euc2-web.posios.com/management/**', { timeout: wachtMs });
    } catch (navErr) {
      let diag = '';
      try {
        diag = await page.evaluate(() => {
          const turnstile = !!document.querySelector('input[name="cf-turnstile-response"], [class*="turnstile"], iframe[src*="challenges.cloudflare"]');
          const txt = (document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 200);
          return JSON.stringify({ turnstile, txt });
        });
      } catch {}
      console.error('[ls-login] Niet teruggekeerd naar backoffice. Diagnose:', diag.slice(0, 320));
      throw navErr;
    }
    console.log('[ls-login] Terug in de backoffice — token ophalen...');

    for (let i = 0; i < 30 && !token; i++) {
      token = await page.evaluate(() => sessionStorage.getItem('apitoken')).catch(() => null);
      if (!token) await page.waitForTimeout(1000);
    }
  } catch (e) {
    const url = page.url();
    if (/mfa|2fa|verify|challenge/i.test(url)) {
      console.error('[ls-login] Login vraagt om MFA/verificatie — headless login kan niet doorgaan. Schakel MFA uit voor dit account of gebruik handmatige token-refresh.');
    } else {
      console.error(`[ls-login] Login mislukt: ${e.message} (url: ${url})`);
    }
    await browser.close();
    process.exit(1);
  }
  await browser.close();

  if (!token) { console.error('[ls-login] Geen apitoken gevonden in sessionStorage.'); process.exit(1); }
  console.log('[ls-login] ✅ Verse apitoken opgehaald.');

  // Naar Supabase instellingen schrijven (de scan leest daar als fallback).
  if (SUPABASE_URL && SUPABASE_KEY) {
    const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
    const { error } = await sb.from('instellingen').upsert(
      { restaurant: 'europizza', key: 'ls_pos_token', value: token, updated_at: new Date().toISOString() },
      { onConflict: 'restaurant,key' });
    if (error) { console.error('[ls-login] Supabase schrijffout:', error.message); process.exit(1); }
    console.log('[ls-login] Token opgeslagen in Supabase instellingen (ls_pos_token).');
  } else {
    console.warn('[ls-login] Supabase ontbreekt — token NIET opgeslagen. Token (kort):', token.slice(0, 8) + '…');
  }

  // Lokaal ook settings.json bijwerken (handig buiten CI).
  if (Object.keys(_sf).length) {
    try { _sf.lsPosToken = token; fs.writeFileSync(path.join(__dirname, 'settings.json'), JSON.stringify(_sf, null, 2)); } catch {}
  }

  // GitHub Actions secret bijwerken zodat de dagelijkse workflow de verse token
  // gebruikt (best-effort; vereist gh CLI ingelogd). Vooral nuttig bij headed refresh.
  try {
    const { execSync } = require('child_process');
    execSync('gh secret set LS_POS_TOKEN', { input: token, cwd: __dirname, stdio: ['pipe', 'ignore', 'ignore'] });
    console.log('[ls-login] GitHub secret LS_POS_TOKEN bijgewerkt.');
  } catch {
    console.log('[ls-login] (gh secret niet bijgewerkt — zet LS_POS_TOKEN evt. handmatig.)');
  }
}

main().catch(e => { console.error('[ls-login] Onverwachte fout:', e.message); process.exit(1); });
