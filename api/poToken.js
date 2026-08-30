// api/poToken.js — Generate YouTube PO Tokens (Proof of Origin) via BotGuard.
//
// Why this exists:
// YouTube blocks datacenter/cloud IPs (Render, Vercel, AWS) with
// "Sign in to confirm you're not a bot" (LOGIN_REQUIRED). To get playable
// formats from those IPs you must send a valid PO Token. This module mints
// them dynamically using bgutils-js (same author as youtubei.js), so the API
// works on Render without any cookies/account.
//
// Flow (per bgutils-js examples):
//   1. Fetch a BotGuard challenge from Google's WAA endpoint (getChallenge).
//   2. Load the BotGuard VM interpreter (needs a browser-like global → jsdom).
//   3. BotGuardClient.snapshot() → botguard response + webPoSignalOutput[].
//   4. Exchange botguard response for an integrity token (GenerateIT).
//   5. WebPoMinter.create(integrityToken, webPoSignalOutput) → minter.
//   6. minter.mintAsWebsafeString(videoId) → content-bound PO token per video.
//
// The minter is cached (integrity token lasts hours). PO tokens are minted
// per-video (content-bound), matching how YouTube's web player behaves.
import { JSDOM } from 'jsdom';
import { BotGuardClient, getChallenge } from 'bgutils-js/botguard';
import { WebPoMinter } from 'bgutils-js/webpo';
import { buildURL, getHeaders, USER_AGENT } from 'bgutils-js/utils';

// Request key used by YouTube's web player for the WAA "Create" endpoint.
const REQUEST_KEY = 'O43z0dpjhgX20SCx4KAo';

let _domSetup = false;
let _minterPromise = null;

// Set up a minimal browser-like global so the BotGuard VM (which expects
// window/document/navigator) can run under Node.
function setupDom() {
  if (_domSetup) return;
  const dom = new JSDOM('<!DOCTYPE html><html><head><title></title></head><body></body></html>', {
    url: 'https://www.youtube.com/',
    referrer: 'https://www.youtube.com/',
    userAgent: USER_AGENT,
  });

  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    origin: dom.window.origin,
  });

  if (!('navigator' in globalThis)) {
    Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator });
  }
  _domSetup = true;
}

// Lazily create + cache the WebPoMinter (the integrity token lives for hours).
export async function getMinter() {
  if (_minterPromise) return _minterPromise;
  _minterPromise = (async () => {
    setupDom();

    // 1) Fetch challenge
    const challenge = await getChallenge({ fetchFunction: fetch, requestKey: REQUEST_KEY });

    const interpreterJs =
      challenge.interpreterJavascript?.privateDoNotAccessOrElseSafeScriptWrappedValue;
    if (!interpreterJs) throw new Error('PO: interpreter javascript not available');

    // 2) Load the BotGuard VM interpreter into globalThis
    new Function(interpreterJs)();

    const botGuardClient = await BotGuardClient.create({
      program: challenge.program,
      globalName: challenge.globalName,
      globalObject: globalThis,
    });

    // 3) Snapshot → botguard response + webPoSignalOutput
    const webPoSignalOutput = [];
    const botguardResponse = await botGuardClient.snapshot({ webPoSignalOutput });

    // 4) Exchange for an integrity token
    const integrityTokenResponse = await fetch(buildURL('GenerateIT', true), {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify([REQUEST_KEY, botguardResponse]),
    });
    if (!integrityTokenResponse.ok) {
      throw new Error(`PO: GenerateIT failed (${integrityTokenResponse.status})`);
    }
    const json = await integrityTokenResponse.json();
    const [integrityToken, estimatedTtlSecs, mintRefreshThreshold, websafeFallbackToken] = json;

    // 5) Create the minter
    const minter = await WebPoMinter.create(
      { integrityToken, estimatedTtlSecs, mintRefreshThreshold, websafeFallbackToken },
      webPoSignalOutput
    );
    return minter;
  })().catch((e) => {
    // Allow a retry on next call if init failed.
    _minterPromise = null;
    throw e;
  });
  return _minterPromise;
}

// Mint a content-bound PO token for a given video id (web-safe base64).
// Returns null if generation fails (callers should fall back gracefully).
export async function getPoTokenForVideo(videoId) {
  try {
    const minter = await getMinter();
    return await minter.mintAsWebsafeString(videoId);
  } catch (e) {
    console.error('[poToken] mint failed:', e?.message || e);
    return null;
  }
}
