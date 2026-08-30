// api/_lib.js — shared youtubei.js helper for Render (Express)
//
// youtubei.js v18 SABR-aware resolver.
//
// Background: YouTube rolled out "SABR" (a custom streaming protocol) on the
// WEB client. After the rollout, adaptive_formats in the player response no
// longer carry direct googlevideo URLs / signature_cipher — only a SABR
// streaming URL remains. Mobile/VR clients (ANDROID_VR, IOS, TV) still return
// direct URLs, BUT on datacenter IPs (Render/AWS/Vercel) YouTube frequently
// returns an empty "failed with status" response for those clients even with
// a valid PO token.
//
// This module fixes that by:
//   1. Using youtubei.js v18's canonical API: `format.decipher(player)` which
//      returns a Promise<string> (the old code relied on lazy `f.url` getters
//      that return undefined on WEB until deciphered).
//   2. Falling back to `streaming_data.dash_manifest_url` / `hls_manifest_url`
//      when no direct per-format URLs can be resolved (the SABR case).
//   3. As a last resort, generating a DASH manifest via `info.toDash()`, which
//      reconstructs playable URLs from the streaming data using the player's
//      decipher/nSig logic.
import { Innertube, Platform } from 'youtubei.js';
import { getPoTokenForVideo } from './poToken.js';

// youtubei.js needs a JS interpreter to decipher signature-protected URLs.
Platform.shim.eval = async (data) => new Function(data.output)();

// Client priority order — tuned for datacenter IPs (Render/AWS):
//   IOS is the BEST client on datacenter IPs: with a content-bound PO token it
//   returns ALL adaptive formats (audio + video at multiple qualities) with
//   direct googlevideo URLs that return HTTP 200. It also returns an
//   hls_manifest_url. Confirmed working 2025-08.
//   ANDROID_VR returns URLs too but they 403 on datacenter IPs (kept as a
//   fallback in case IOS is ever rate-limited).
//   WEB is SABR-rolled-out (only itag 18 progressive resolves directly), so it
//   is kept LAST as a manifest fallback (dash_manifest_url / hls_manifest_url).
//   When a cookie is set, WEB/WEB_EMBEDDED are tried first ONLY for bot-blocked
//   videos (the IOS request will fail with LOGIN_REQUIRED first in that case,
//   and we fall through to WEB+cookie). For normal videos IOS always wins.
const PREFERRED_CLIENTS = ['IOS', 'ANDROID_VR', 'ANDROID', 'TV', 'TV_EMBEDDED', 'WEB', 'WEB_EMBEDDED'];
const PREFERRED_CLIENTS_WITH_COOKIE = ['IOS', 'ANDROID_VR', 'WEB', 'WEB_EMBEDDED', 'ANDROID', 'TV', 'TV_EMBEDDED'];
function getClientOrder() {
  return YOUTUBE_COOKIE ? PREFERRED_CLIENTS_WITH_COOKIE : PREFERRED_CLIENTS;
}

// Reuse client across warm invocations (Render keeps the process alive).
let _yt = null;
let _clientPromise = null;
let _visitorData = null;

// A separate cookie-FREE client for mobile/VR clients (IOS, ANDROID_VR,
// ANDROID, TV). Web cookies (SAPISID/SID/etc) cause these clients' player
// requests to fail with HTTP 400, so they must use a clean session.
let _ytMobile = null;
let _mobileClientPromise = null;

// A session-bound cold-start PO token.
let _sessionPoToken = null;

// Optional YouTube cookies (from a logged-in browser session).
const _FALLBACK_COOKIE = 'VISITOR_INFO1_LIVE=celiqJiXjLo; PREF=tz=Asia.Karachi&f4=4000000; __Secure-1PSIDTS=sidts-CjUBXMw41e7uv8_aMUSeby_XDYWMgeEFq73eJ0V5yWO6hIg0ArhRmLD00rN4uNrovK-7IygAiBAA; __Secure-3PSIDTS=sidts-CjUBXMw41e7uv8_aMUSeby_XDYWMgeEFq73eJ0V5yWO6hIg0ArhRmLD00rN4uNrovK-7IygAiBAA; HSID=AOrG-eZHh-ZNCI0Ql; SSID=AsniwGOr2aP4hzU0A; APISID=DMRdO6_heMVqNwkU/AO9lLkBQPQqzETeBY; SAPISID=WM5JZxp4Up0s-sPI/AeNbMusFn2Hbh2cWO; __Secure-3PAPISID=WM5JZxp4Up0s-sPI/AeNbMusFn2Hbh2cWO; SID=g.a000CAmXWbB42prX468wn499VlMRLLlKA-BMF2ZtXpfkUOIQVTI_DPtEzMyTSbnBgtBVvtmlzQACgYKAfMSARQSFQHGX2MiID1iBxAdYQafqzx1TAnJzxoVAUF8yKpTzruQKTX0xyRzt6u8L7yP0076; __Secure-1PSID=g.a000CAmXWbB42prX468wn499VlMRLLlKA-BMF2ZtXpfkUOIQVTI_S2fNJzusVF3XQYUHjn7oiAACgYKAcMSARQSFQHGX2MiB11g9_4p7ja-MTWN2jp-ZxoVAUF8yKpu70Bm6MfadNwuYz9b_Tj40076; __Secure-3PSID=g.a000CAmXWbB42prX468wn499VlMRLLlKA-BMF2ZtXpfkUOIQVTI_AQNv6OXqGz-FN26H9zzl-AACgYKAbcSARQSFQHGX2MiwXkVKLYosYJ9PlkEGqDMXBoVAUF8yKqPepMvaXexUkARnv6NYBnL0076; LOGIN_INFO=AFmmF2swRQIgEJYFljF9A1XG-nFa9yId4xvYpdX4enX-vG8vevaoSlACIQDw9n_v1RuaJfC0LfLRjWNO_XFGJobFWICvnP-VcFUJ1A:QUQ3MjNmenVoNl9xUW0zcEszQkVxcFRzZzZxT1kzS1BvS3NvV1AwNkVnMGUxUWNkTnZzLVM5MUlfa01qdk1qanl3c19OSXhkcjRQVGlZeVdiZTdRY3JoZHJNZHh6aVJ2UWxDUUt5OGZaWjBrbWtlODFVS1FmSWRlUGIyZFh4dlVmWG9aSDVHbzQxem85S1hNTFVkeU9vQXNMajVyeDJsUnZB; SIDCC=AKEyXzW3aNqmOGRwsTBXJufAwRsSaRcmXfxERyKDwIv_7WSrD-mFKDDQJHeYQVSReX6VN0om; YSC=6VTSiMXhRAo';
const YOUTUBE_COOKIE = process.env.YOUTUBE_COOKIE || process.env.YT_COOKIE || _FALLBACK_COOKIE;

export async function getClient() {
  if (_yt) return _yt;
  if (_clientPromise) return _clientPromise;
  _clientPromise = Innertube.create({
    retrieve_player: true,
    enable_session_cache: false,
    generate_session_locally: !_visitorData && !YOUTUBE_COOKIE,
    cookie: YOUTUBE_COOKIE || undefined,
  }).then(async (c) => {
    try {
      _visitorData = c.session?.context?.client?.visitorData || null;
    } catch {}

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

export async function getClientWithPoTokenExposed() {
  return getClientWithPoToken();
}

// A cookie-free Innertube instance for mobile/VR clients. Web cookies cause
// IOS/ANDROID_VR/ANDROID/TV player requests to fail with HTTP 400.
async function getMobileClient() {
  if (_ytMobile) return _ytMobile;
  if (_mobileClientPromise) return _mobileClientPromise;
  _mobileClientPromise = Innertube.create({
    retrieve_player: true,
    enable_session_cache: false,
    generate_session_locally: true,
    // NO cookie — mobile clients use their own auth flow + PO token.
  }).then((c) => {
    _ytMobile = c;
    return c;
  }).catch(e => {
    _mobileClientPromise = null;
    throw e;
  });
  return _mobileClientPromise;
}

async function getClientWithPoToken() {
  const c = await getClient();
  if (!_sessionPoToken) return c;
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
    if (/^[\w-]{11}$/.test(url)) return url;
    return null;
  }
}

// ---------------------------------------------------------------------------
// v18 canonical URL resolution for a single Format object.
// Order: deciphered_url (string) -> f.url (string) -> f.decipher(player) -> player.decipher(f)
// f.decipher(player) returns Promise<string> and is the SUPPORTED v18 API.
// ---------------------------------------------------------------------------
async function resolveFormatUrl(f, player) {
  try {
    if (f.deciphered_url && typeof f.deciphered_url === 'string') return f.deciphered_url;
    if (f.url && typeof f.url === 'string') return f.url;
    if (typeof f.decipher === 'function') {
      const d = f.decipher(player);
      const u = (d && typeof d.then === 'function') ? await d : d;
      if (u && typeof u === 'string') return u;
    }
    if (player && typeof player.decipher === 'function') {
      const d = player.decipher(f);
      const u = (d && typeof d.then === 'function') ? await d : d;
      if (u && typeof u === 'string') return u;
    }
  } catch {}
  return null;
}

// Synthetic manifest entry so pickFormat()/info.js/download.js can handle the
// case where the player only returned a DASH/HLS manifest URL (SABR rollout).
function manifestEntry(info, kind, url) {
  const isHls = kind === 'hls';
  return {
    f: {
      itag: isHls ? -1 : -2,
      mime_type: isHls ? 'application/x-mpegurl' : 'application/dash+xml',
      has_video: true,
      has_audio: true,
      height: null,
      bitrate: 0,
      content_length: null,
    },
    url,
    is_manifest: kind,
  };
}

export async function getFormats(videoId) {
  const yt = await getClientWithPoToken();
  const player = yt.session?.player;
  const errs = [];
  let best = null;

  // Content-bound PO token for this video (sent in the player request context).
  // This is CRITICAL for IOS/ANDROID_VR on datacenter IPs: without it the
  // player response is empty ("failed with status code 400").
  const contentPoToken = await getPoTokenForVideo(videoId);

  // Lazily get the cookie-free mobile client (needed for IOS/ANDROID_VR/etc).
  let mobileYt = null;
  let mobilePlayer = null;
  try {
    mobileYt = await getMobileClient();
    mobilePlayer = mobileYt.session?.player;
  } catch (e) {
    errs.push(`mobile-client-init: ${e.message?.slice(0, 80) || 'error'}`);
  }

  for (const client of getClientOrder()) {
    try {
      let info;
      let decipherPlayer = player;
      const isWebClient = (client === 'WEB' || client === 'WEB_EMBEDDED');

      if (isWebClient && YOUTUBE_COOKIE) {
        // WEB clients use the cookie (for bot-blocked videos) instead of PO token.
        const freshYt = await Innertube.create({
          retrieve_player: true,
          enable_session_cache: false,
          generate_session_locally: false,
          cookie: YOUTUBE_COOKIE,
        });
        info = await freshYt.getBasicInfo(videoId, client);
        decipherPlayer = freshYt.session?.player || decipherPlayer;
      } else if (isWebClient) {
        // WEB without cookie — use the main client (may be SABR'd).
        info = await yt.getBasicInfo(videoId, { client });
      } else {
        // Mobile/VR clients (IOS, ANDROID_VR, ANDROID, TV, TV_EMBEDDED) use the
        // cookie-free mobile client + content PO token.
        if (!mobileYt) throw new Error('mobile client unavailable');
        info = await mobileYt.getBasicInfo(videoId, {
          client,
          poToken: contentPoToken || _sessionPoToken || undefined,
        });
        decipherPlayer = mobilePlayer || decipherPlayer;
      }

      const sd = info?.streaming_data;
      const rawFormats = [
        ...(sd?.adaptive_formats || []),
        ...(sd?.formats || []),
        ...(info?.formats || []),
      ];

      // Resolve direct per-format URLs using v18's decipher() API.
      const resolved = await Promise.all(
        rawFormats.map(async (f) => ({ f, url: await resolveFormatUrl(f, decipherPlayer) }))
      );
      const resolvedFiltered = resolved.filter((r) => r.url && typeof r.url === 'string');

      // SABR fallback: if no direct URLs resolved, use manifest URLs if present.
      const dashUrl = sd?.dash_manifest_url || null;
      const hlsUrl = sd?.hls_manifest_url || null;
      const manifestEntries = [];
      // Always include hls_manifest_url if present (IOS returns it alongside
      // direct URLs — useful for clients that prefer HLS).
      if (hlsUrl) manifestEntries.push(manifestEntry(info, 'hls', hlsUrl));
      // Only add DASH manifest if no direct URLs resolved (WEB SABR case).
      if (!resolvedFiltered.length && dashUrl) manifestEntries.push(manifestEntry(info, 'dash', dashUrl));

      const totalUsable = resolvedFiltered.length + manifestEntries.length;
      const playability = info?.playability_status?.status || 'unknown';

      if (!totalUsable) {
        errs.push(`${client}: no formats/manifests (status=${playability})`);
        continue;
      }

      const bestTotal = best ? (best.resolved.length + (best.manifests?.length || 0)) : -1;
      if (totalUsable > bestTotal) {
        best = { info, resolved: resolvedFiltered, manifests: manifestEntries, client };
      }
      // IOS is the proven best client on datacenter IPs — if it resolves
      // enough formats, stop trying other clients.
      if (client === 'IOS' && resolvedFiltered.length >= 5) break;
    } catch (e) {
      const msg = e.message?.slice(0, 120) || 'error';
      if (msg.includes('Invalid client')) {
        errs.push(`${client}: not supported in this version`);
      } else {
        errs.push(`${client}: ${msg}`);
      }
    }
  }

  // Last-ditch recovery: if nothing usable was found, try info.toDash() on the
  // first client that returns streaming_data. This reconstructs playable URLs
  // from (possibly SABR-only) streaming data via the player's decipher/nSig.
  if (!best || (!best.resolved.length && !best.manifests?.length)) {
    for (const client of getClientOrder()) {
      try {
        let info;
        const isWebClient = (client === 'WEB' || client === 'WEB_EMBEDDED');
        if (isWebClient && YOUTUBE_COOKIE) {
          const freshYt = await Innertube.create({
            retrieve_player: true,
            enable_session_cache: false,
            generate_session_locally: false,
            cookie: YOUTUBE_COOKIE,
          });
          info = await freshYt.getBasicInfo(videoId, client);
        } else if (isWebClient) {
          info = await yt.getBasicInfo(videoId, { client });
        } else {
          if (!mobileYt) continue;
          info = await mobileYt.getBasicInfo(videoId, {
            client,
            poToken: contentPoToken || _sessionPoToken || undefined,
          });
        }
        if (info?.streaming_data && typeof info.toDash === 'function') {
          const dashXml = await info.toDash();
          if (dashXml && typeof dashXml === 'string' && dashXml.length > 100) {
            const dataUrl = 'data:application/dash+xml;charset=utf-8,' + encodeURIComponent(dashXml);
            best = {
              info,
              resolved: [],
              manifests: [manifestEntry(info, 'dash', dataUrl)],
              client: client + '(toDash)',
            };
            break;
          }
        }
      } catch (e) {
        errs.push(`${client}(toDash): ${e.message?.slice(0, 80) || 'error'}`);
      }
    }
  }

  if (!best || (!best.resolved.length && !best.manifests?.length)) {
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

// Combine resolved direct formats + manifest entries into a single list so
// callers can treat them uniformly. Manifests are appended last (lower pref).
export function getAllResolved(best) {
  if (!best) return [];
  return [...(best.resolved || []), ...(best.manifests || [])];
}

export function pickFormat(resolved, type, quality) {
  // Ignore manifest entries for direct audio/video picking (they contain both).
  const direct = resolved.filter((r) => !r.is_manifest);

  if (type === 'audio') {
    const audios = direct
      .filter(r => (r.f.mime_type || '').startsWith('audio') || (r.f.has_audio && !r.f.has_video))
      .sort((a, b) => (b.f.bitrate || 0) - (a.f.bitrate || 0));
    if (audios[0]) return audios[0];
    // No direct audio — fall back to a manifest (HLS/DASH carry audio).
    const mani = resolved.find(r => r.is_manifest);
    if (mani) return mani;
    return null;
  }

  const vids = direct
    .filter(r => (r.f.mime_type || '').startsWith('video') || (r.f.has_video && !r.f.has_audio))
    .sort((a, b) => (a.f.height || 999) - (b.f.height || 999));

  const combined = direct
    .filter(r => r.f.has_audio && r.f.has_video)
    .sort((a, b) => (a.f.height || 999) - (b.f.height || 999));

  const wantQ = quality ? parseInt(quality) : 0;

  if (wantQ) {
    const cm = combined.find(r => r.f.height === wantQ);
    if (cm) return cm;
    const vm = vids.find(r => r.f.height === wantQ);
    if (vm) return vm;
    const higher = vids.find(r => (r.f.height || 0) >= wantQ);
    if (higher) return higher;
    if (vids.length) return vids[vids.length - 1];
  }

  if (combined.length) return combined[0];
  if (vids.length) return vids.find(r => r.f.height === 360) || vids[0];
  // Last resort: a manifest entry (HLS/DASH playable by capable clients).
  const mani = resolved.find(r => r.is_manifest);
  if (mani) return mani;
  return null;
}

export function safeName(s) {
  return (s || 'video').replace(/[ /\\:*?"<>|]/g, '_').slice(0, 60);
}

export function sendJson(res, code, obj) {
  res.status(code).json(obj);
}
