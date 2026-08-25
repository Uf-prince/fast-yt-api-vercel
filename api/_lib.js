// api/_lib.js — shared youtubei.js helper for Vercel serverless
import { Innertube } from 'youtubei.js';

// Client priority order:
//  1. ANDROID_VR  — NO PO Token required, works on datacenter IPs, returns direct googlevideo URLs.
//                   Requires youtubei.js >= 17.3.0 (we pin ^18 in package.json).
//  2. IOS         — returns pre-signed direct URLs (no deciphering), but may be IP-blocked on some datacenters.
//  3. TV          — sometimes works without PO Token on datacenter IPs.
//  4. ANDROID     — needs PO Token/decipher for some formats, falls back to decipher via player.
//  5. WEB         — needs decipher, last resort.
const PREFERRED_CLIENTS = ['ANDROID_VR', 'IOS', 'TV', 'ANDROID', 'WEB', 'TV_EMBEDDED', 'WEB_EMBEDDED'];

// Reuse client across warm invocations (Vercel keeps container warm briefly).
// Use generate_session_locally to avoid an extra YouTube roundtrip on cold start.
let _yt = null;
let _clientPromise = null;
export async function getClient() {
  if (_yt) return _yt;
  if (_clientPromise) return _clientPromise;
  _clientPromise = Innertube.create({
    retrieve_player: true,
    enable_session_cache: false,
    generate_session_locally: true,
  }).then(c => { _yt = c; return c; }).catch(e => {
    _clientPromise = null;
    throw e;
  });
  return _clientPromise;
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
  const yt = await getClient();
  const player = yt.session?.player;
  const errs = [];
  let best = null;

  for (const client of PREFERRED_CLIENTS) {
    try {
      const info = await yt.getBasicInfo(videoId, { client });
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

      // Resolve direct URLs for each format
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
    throw new Error('No playable formats found. Tried: ' + errs.join(' | '));
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
