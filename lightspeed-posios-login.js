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
  if (!USER || !PASS) { console.error('[ls-login] LS_POS_USER / LS_POS_PASS ontbreken'); process.exit(1); }

  console.log('[ls-login] Browser starten...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  let token = null;
  try {
    // Backoffice openen → redirect naar Lightspeed ID login (geen sessie in verse context).
    await page.goto(ENTRY, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await page.waitForURL('**id.lightspeed.app/**', { timeout: TIMEOUT });
    console.log('[ls-login] Loginpagina (Lightspeed ID) — inloggen...');

    // pressSequentially i.p.v. fill: de submit-knop is disabled tot het formulier
    // geldig is, en controlled inputs registreren alleen echte toetsaanslagen.
    await page.locator('#username, input[name="username"]').click({ timeout: 15000 });
    await page.locator('#username, input[name="username"]').pressSequentially(USER, { delay: 15 });
    await page.locator('#password, input[name="password"]').click({ timeout: 15000 });
    await page.locator('#password, input[name="password"]').pressSequentially(PASS, { delay: 15 });
    // Wacht tot de knop actief is, klik; val terug op Enter.
    try {
      await page.waitForSelector('button[type="submit"]:not([disabled])', { timeout: 10000 });
      await page.click('button[type="submit"]');
    } catch {
      await page.locator('#password, input[name="password"]').press('Enter');
    }

    // Terug naar de backoffice; daarna verschijnt de sessie-apitoken in sessionStorage.
    try {
      await page.waitForURL('**euc2-web.posios.com/management/**', { timeout: TIMEOUT });
    } catch (navErr) {
      // Diagnose: waarom bleven we op de loginpagina? (fout ww / MFA / bot-check)
      let diag = '';
      try {
        diag = await page.evaluate(() => {
          const txt = (document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 400);
          const captcha = !!document.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], [class*="captcha"]');
          return JSON.stringify({ captcha, txt });
        });
      } catch {}
      console.error('[ls-login] Niet teruggekeerd naar backoffice. Pagina-diagnose:', diag.slice(0, 420));
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
}

main().catch(e => { console.error('[ls-login] Onverwachte fout:', e.message); process.exit(1); });
