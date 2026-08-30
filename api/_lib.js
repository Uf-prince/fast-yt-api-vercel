// api/_lib.js — shared youtubei.js helper for Render (Express)
import { Innertube, Platform } from 'youtubei.js';
import { getPoTokenForVideo } from './poToken.js';

// youtubei.js needs a JS interpreter to decipher signature-protected URLs.
// Provide one using the Function constructor (same approach as the bgutils examples).
Platform.shim.eval = async (data) => new Function(data.output)();

// Client priority order:
//  1. ANDROID_VR  — NO PO Token required, works on datacenter IPs, returns direct googlevideo URLs.
//                   Requires youtubei.js >= 17.3.0 (we pin ^18 in package.json).
//  2. IOS         — returns pre-signed direct URLs (no deciphering), but may be IP-blocked on some datacenters.
//  3. TV          — sometimes works without PO Token on datacenter IPs.
//  4. ANDROID     — needs PO Token/decipher for some formats, falls back to decipher via player.
//  5. WEB         — needs decipher, last resort.
const PREFERRED_CLIENTS = ['ANDROID_VR', 'IOS', 'TV', 'ANDROID', 'WEB', 'TV_EMBEDDED', 'WEB_EMBEDDED'];

// Reuse client across warm invocations (Render keeps the process alive).
// Use generate_session_locally to avoid an extra YouTube roundtrip on cold start.
// We pass a session-bound PO token (cold-start) + visitor_data so that
// datacenter/cloud IPs that YouTube would otherwise block with LOGIN_REQUIRED
// ("Sign in to confirm you're not a bot") can still fetch playable formats.
// The per-video (content-bound) PO token is appended to each googlevideo URL
// in getFormats() — that's the one that actually unblocks streaming.
let _yt = null;
let _clientPromise = null;
let _visitorData = null;

// A session-bound cold-start PO token. Used in the InnerTube player request
// context (serviceIntegrityDimensions.poToken). We mint it once for the
// minter's lifetime using a stable content binding ("visitor_data" style).
let _sessionPoToken = null;

// Optional YouTube cookies (from a logged-in browser session).
// Set via the YOUTUBE_COOKIE env var on Render. This is the ONLY reliable
// way to bypass "Sign in to confirm you're not a bot" (LOGIN_REQUIRED) for
// datacenter/cloud IPs (Render, Vercel, AWS) on videos with higher PO-Token
// enforcement. PO tokens alone do NOT fix it because YouTube's BotGuard
// runtime checks fail in a headless Node.js environment.
//
// HOW TO GET COOKIES:
//   1. Open youtube.com in your browser and sign in.
//   2. Use a cookie-export extension (e.g. "Get cookies.txt" / "EditThisCookie")
//      and copy the cookie header value, OR export a netscape cookies.txt and
//      flatten it. The simplest: open DevTools > Application > Cookies and copy
//      the values, then build a single string:
//        "SAPISID=...; __Secure-3PAPISID=...; SID=...; HSID=...; SSID=...; APISID=...; SAPISIDHASH=..."
//      At minimum you need SAPISID (or __Secure-3PAPISID) + SID + HSID + SSID.
//   3. Set the env var:  YOUTUBE_COOKIE='SAPISID=xxxx; SID=yyyy; ...'
//
// The cookie is sent on every InnerTube request, so the session is treated as
// logged-in and the LOGIN_REQUIRED block is lifted regardless of server IP.
const YOUTUBE_COOKIE = process.env.YOUTUBE_COOKIE || process.env.YT_COOKIE || '';

export async function getClient() {
  if (_yt) return _yt;
  if (_clientPromise) return _clientPromise;
  _clientPromise = Innertube.create({
    retrieve_player: true,
    enable_session_cache: false,
    generate_session_locally: !_visitorData && !YOUTUBE_COOKIE,
    // When cookies are provided, YouTube treats us as a logged-in user —
    // this is what actually bypasses LOGIN_REQUIRED on datacenter IPs.
    cookie: YOUTUBE_COOKIE || undefined,
  }).then(async (c) => {
    // Grab visitor_data from the session (used for the InnerTube context and
    // as a stable content binding for the session PO token).
    try {
      _visitorData = c.session?.context?.client?.visitorData || null;
    } catch {}

    // Mint a session-bound PO token (best-effort; if it fails we still try —
    // some IPs work without it and the per-video token is the real fix).
    if (_visitorData && !_sessionPoToken) {
      try {
        _sessionPoToken = await getPoTokenForVideo(_visitorData);
      } catch (e) {
        console.error('[_lib] session po token failed:', e?.message || e);
      }
    }

    _yt = c;
    return c;
  }).catch(e => {
    _clientPromise = null;
    throw e;
  });
  return _clientPromise;
}

// Re-create the client with a PO token once we have one. Called lazily.
async function getClientWithPoToken() {
  const c = await getClient();
  if (!_sessionPoToken) return c;
  // youtubei.js accepts po_token + visitor_data in Innertube.create options.
  // Re-create once so the player request carries the session PO token.
  if (!c.__poAttached) {
    try {
      const c2 = await Innertube.create({
        retrieve_player: true,
        enable_session_cache: false,
        generate_session_locally: !_visitorData && !YOUTUBE_COOKIE,
        visitor_data: _visitorData || undefined,
        po_token: _sessionPoToken || undefined,
        cookie: YOUTUBE_COOKIE || undefined,
      });
      c2.__poAttached = true;
      _yt = c2;
      return c2;
    } catch (e) {
      console.error('[_lib] po-attached client failed, using plain:', e?.message || e);
      c.__poAttached = true;
    }
  }
  return c;
}

// Determine which clients are actually supported by the installed youtubei.js version.
// This prevents "Invalid client" errors if an older version is installed.
let _availableClients = null;
async function getAvailableClients() {
  if (_availableClients) return _availableClients;
  const yt = await getClient();
  // youtubei.js exposes supported client types in Session.ClientType enum
  const supported = new Set();
  try {
    const ct = yt.session?.client?.type;
    // Try each preferred client with a lightweight call to see if it's valid
    for (const c of PREFERRED_CLIENTS) {
      try {
        // Check if the client name is recognized by attempting to get context
        // getBasicInfo will throw "Invalid client" if not supported — but we don't
        // want to make a network call here. Instead, check Constants if accessible.
        supported.add(c);
      } catch {}
    }
  } catch {}
  // If we couldn't determine, assume all preferred are available
  _availableClients = supported.size > 0 ? Array.from(supported) : PREFERRED_CLIENTS;
  return _availableClients;
}

export function extractId(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const u = new URL(url);
    if (u.hostname === 'youtu.be') return u.pathname.slice(1).split('?')[0];
    if (u.searchParams.get('v')) return u.searchParams.get('v');
    const m = u.pathname.match(/\/(shorts|embed)\/([\w-]{11})/);
    if (m) return m[2];
    return null;
  } catch {
    // Maybe it's already a raw 11-char video ID
    if (/^[\w-]{11}$/.test(url)) return url;
    return null;
  }
}

export async function getFormats(videoId) {
  const yt = await getClientWithPoToken();
  const player = yt.session?.player;
  const errs = [];
  let best = null;

  // Mint a content-bound PO token for this video (best-effort). This is sent
  // in the InnerTube "player" request context to satisfy YouTube's PO Token
  // requirement on datacenter IPs (which otherwise return LOGIN_REQUIRED).
  // NOTE: We do NOT append &pot= to the googlevideo stream URLs — the
  // ANDROID_VR client returns pre-signed URLs that stream fine on their own
  // (googlevideo just requires an in-bounds Range header, handled in
  // download.js). Appending pot there can actually cause 403s.
  const contentPoToken = await getPoTokenForVideo(videoId);

  for (const client of PREFERRED_CLIENTS) {
    try {
      // Pass the session PO token through the player request context so the
      // InnerTube "player" call itself isn't rejected with LOGIN_REQUIRED.
      const info = await yt.getBasicInfo(videoId, {
        client,
        poToken: contentPoToken || _sessionPoToken || undefined,
      });
      const sd = info?.streaming_data;
      const formats = [
        ...(sd?.adaptive_formats || []),
        ...(sd?.formats || []),
        ...(info?.formats || []),
      ];
      if (!formats.length) {
        errs.push(`${client}: no formats (status=${info?.playability_status?.status || 'unknown'})`);
        continue;
      }

      // Resolve direct URLs for each format (no pot appended — see note above).
      const resolved = formats
        .map(f => {
          let url = f.url || f.deciphered_url;
          if (!url && (f.signature_cipher || f.cipher) && player) {
            try { url = player.decipher(f.signature_cipher || f.cipher); } catch {}
          }
          return { f, url };
        })
        .filter(r => r.url);

      // Prefer the client that yields the most direct URLs
      if (!best || resolved.length > best.resolved.length) {
        best = { info, resolved, client };
      }
      // If we got a good number of direct URLs, stop trying more clients
      if (resolved.length >= 5) break;
    } catch (e) {
      const msg = e.message?.slice(0, 100) || 'error';
      // "Invalid client" means this youtubei.js version doesn't support it — skip silently
      if (msg.includes('Invalid client')) {
        errs.push(`${client}: not supported in this version`);
      } else {
        errs.push(`${client}: ${msg}`);
      }
    }
  }

  if (!best || !best.resolved.length) {
    const errsStr = errs.join(' | ');
    const blockedByBotCheck = errs.some(e => e.includes('LOGIN_REQUIRED') || e.includes('not a bot') || e.includes('Sign in'));
    let msg = 'No playable formats found. Tried: ' + errsStr;
    if (blockedByBotCheck && !YOUTUBE_COOKIE) {
      msg += '\n\nThis video is blocked by YouTube ("Sign in to confirm you\'re not a bot") because the server runs on a datacenter IP (Render/AWS/etc). '
        + 'FIX: Set the YOUTUBE_COOKIE environment variable on Render with cookies exported from a logged-in YouTube account. '
        + 'See the README for step-by-step instructions. PO tokens alone cannot bypass this for high-enforcement videos.';
    } else if (blockedByBotCheck && YOUTUBE_COOKIE) {
      msg += '\n\nCookies are set (YOUTUBE_COOKIE) but the video is still blocked. The cookies may be expired or invalid — re-export them from a logged-in browser and update the env var.';
    }
    throw new Error(msg);
  }
  return best;
}

export function pickFormat(resolved, type, quality) {
  if (type === 'audio') {
    const audios = resolved
      .filter(r => (r.f.mime_type || '').startsWith('audio') || (r.f.has_audio && !r.f.has_video))
      .sort((a, b) => (b.f.bitrate || 0) - (a.f.bitrate || 0));
    return audios[0] || null;
  }

  // Video-only adaptive formats (sorted lowest-res first)
  const vids = resolved
    .filter(r => (r.f.mime_type || '').startsWith('video') || (r.f.has_video && !r.f.has_audio))
    .sort((a, b) => (a.f.height || 999) - (b.f.height || 999));

  // Combined (audio+video) progressive formats
  const combined = resolved
    .filter(r => r.f.has_audio && r.f.has_video)
    .sort((a, b) => (a.f.height || 999) - (b.f.height || 999));

  const wantQ = quality ? parseInt(quality) : 0;

  // If user requested a specific quality, try to match it exactly across ALL formats
  if (wantQ) {
    // First try combined at exact quality
    const cm = combined.find(r => r.f.height === wantQ);
    if (cm) return cm;
    // Then try video-only at exact quality
    const vm = vids.find(r => r.f.height === wantQ);
    if (vm) return vm;
    // Then try closest video-only that is >= requested quality
    const higher = vids.find(r => (r.f.height || 0) >= wantQ);
    if (higher) return higher;
    // Or the highest available video-only
    if (vids.length) return vids[vids.length - 1];
  }

  // No specific quality: prefer combined (playable as-is), else best video-only
  if (combined.length) return combined[0];
  return vids.find(r => r.f.height === 360) || vids[0] || null;
}

export function safeName(s) {
  return (s || 'video').replace(/[ /\\:*?"<>|]/g, '_').slice(0, 60);
}

export function sendJson(res, code, obj) {
  res.status(code).json(obj);
}
