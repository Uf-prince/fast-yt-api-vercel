// api/_lib.js — shared youtubei.js helper for Vercel serverless
import { Innertube } from 'youtubei.js';

const UA = 'com.google.ios.youtube/19.45.4 (iPhone16,2; U; CPU iOS 17_5_1 like Mac OS X)';
const CLIENT_ORDER = ['IOS', 'TV', 'TV_EMBEDDED', 'ANDROID', 'WEB_EMBEDDED', 'WEB'];

// Reuse client across warm invocations (Vercel keeps container warm briefly)
let _yt = null;
export async function getClient() {
  if (!_yt) {
    _yt = await Innertube.create({ retrieve_player: true, enable_session_cache: false });
  }
  return _yt;
}

export function extractId(url) {
  try {
    const u = new URL(url);
    if (u.hostname === 'youtu.be') return u.pathname.slice(1).split('?')[0];
    if (u.searchParams.get('v')) return u.searchParams.get('v');
    const m = u.pathname.match(/\/(shorts|embed)\/([\w-]{11})/);
    if (m) return m[2];
    return null;
  } catch { return null; }
}

export async function getFormats(videoId) {
  const yt = await getClient();
  const player = yt.session?.player;
  const errs = [];
  let best = null;
  for (const client of CLIENT_ORDER) {
    try {
      const info = await yt.getBasicInfo(videoId, { client });
      const sd = info?.streaming_data;
      const formats = [...(sd?.adaptive_formats||[]), ...(sd?.formats||[]), ...(info?.formats||[])];
      if (!formats.length) { errs.push(`${client}: no formats`); continue; }
      const resolved = formats.map(f => {
        let url = f.url || f.deciphered_url;
        if (!url && (f.signature_cipher||f.cipher) && player) {
          try { url = player.decipher(f.signature_cipher || f.cipher); } catch {}
        }
        return { f, url };
      }).filter(r => r.url);
      if (!best || resolved.length > best.resolved.length) best = { info, resolved };
      if (resolved.length) break;
    } catch (e) { errs.push(`${client}: ${e.message}`); }
  }
  if (!best || !best.resolved.length) throw new Error('No playable formats: ' + errs.join(' | '));
  return best;
}

export function pickFormat(resolved, type, quality) {
  if (type === 'audio') {
    return resolved.filter(r => (r.f.mime_type||'').startsWith('audio'))
      .sort((a,b) => (b.f.bitrate||0) - (a.f.bitrate||0))[0];
  }
  const combined = resolved.filter(r => r.f.has_audio && r.f.has_video)
    .sort((a,b) => (a.f.height||999) - (b.f.height||999));
  if (combined.length) {
    if (quality) {
      const m = combined.find(r => r.f.height === parseInt(quality));
      if (m) return m;
    }
    return combined[0];
  }
  const vids = resolved.filter(r => (r.f.mime_type||'').startsWith('video'))
    .sort((a,b) => (a.f.height||999) - (b.f.height||999));
  if (quality) {
    const m = vids.find(r => r.f.height === parseInt(quality));
    if (m) return m;
  }
  return vids.find(r => r.f.height === 360) || vids[0];
}

export function safeName(s) {
  return (s||'video').replace(/[ /\\:*?"<>|]/g, '_').slice(0, 60);
}

export function sendJson(res, code, obj) {
  res.status(code).json(obj);
}
