// api/info.js — Vercel serverless: GET /api/info?url=YOUTUBE_URL
// Returns JSON: title, author, thumbnail, duration, all formats with direct googlevideo URLs
import { getClient, extractId, getFormats, sendJson } from './_lib.js';

export default async function handler(req, res) {
  const url = req.query.url;
  if (!url) return sendJson(res, 400, { error: 'missing url param' });
  const id = extractId(url);
  if (!id) return sendJson(res, 400, { error: 'could not parse video id from url' });

  const t0 = Date.now();
  try {
    const { info, resolved } = await getFormats(id);
    const medias = resolved.map(({ f, url: u }) => {
      const mime = f.mime_type || '';
      const isAudio = mime.startsWith('audio') || (f.has_audio && !f.has_video);
      return {
        itag: f.itag,
        type: isAudio ? 'audio' : 'video',
        quality: isAudio ? `${Math.round((f.bitrate||0)/1000)}kbps` : `${f.height||'?'}p`,
        ext: mime.includes('webm') ? 'webm' : mime.includes('mp4') ? 'mp4' : 'm4a',
        mimeType: mime,
        hasAudio: f.has_audio,
        hasVideo: f.has_video,
        bitrate: f.bitrate,
        url: u,
      };
    });
    sendJson(res, 200, {
      title: info.basic_info?.title,
      author: info.basic_info?.author,
      duration: info.basic_info?.duration,
      thumbnail: info.basic_info?.thumbnail?.[0]?.url,
      medias,
      time_ms: Date.now() - t0,
    });
  } catch (e) {
    const msg = e.message || '';
    const blocked = msg.includes('LOGIN_REQUIRED') || msg.includes('not a bot') || msg.includes('Sign in');
    // Cookie is considered "set" if the env var is present OR the hardcoded
    // fallback cookie in _lib.js is available (which it always is now, unless
    // explicitly emptied). We report it so clients can tell "blocked despite
    // cookie" (expired) from "no cookie at all".
    const hasCookie = !!(process.env.YOUTUBE_COOKIE || process.env.YT_COOKIE) || true;
    // Return a structured error so clients can detect the "needs auth" case
    // and surface the right message to their users.
    sendJson(res, 502, {
      error: msg,
      needs_auth: blocked,
      cookie_set: hasCookie,
      hint: blocked
        ? (hasCookie
            ? 'YouTube cookies are set but appear expired/invalid. Re-export cookies from a logged-in browser and update YOUTUBE_COOKIE.'
            : 'Set the YOUTUBE_COOKIE env var with cookies from a logged-in YouTube account to bypass the "not a bot" block on datacenter IPs. See README.')
        : undefined,
    });
  }
}
