// api/download.js — Vercel serverless: GET /api/download?url=URL&type=audio|video&quality=360|720|1080
// Streams the media file directly from googlevideo.com to the client using Range requests.
// Falls back to 302 redirect to the direct googlevideo URL if streaming fails.
import { getClient, extractId, getFormats, pickFormat, safeName, sendJson } from './_lib.js';

export default async function handler(req, res) {
  const url = req.query.url;
  if (!url) return sendJson(res, 400, { error: 'missing url param' });

  const id = extractId(url);
  if (!id) return sendJson(res, 400, { error: 'could not parse video id from url' });

  const type = (req.query.type || 'video').toLowerCase();
  const quality = req.query.quality || '';

  try {
    const { info, resolved } = await getFormats(id);
    const picked = pickFormat(resolved, type, quality);
    if (!picked) return sendJson(res, 404, { error: `no ${type} format found` });

    const mediaUrl = picked.url;
    const mime = picked.f.mime_type || (type === 'audio' ? 'audio/mp4' : 'video/mp4');
    const ext = mime.includes('webm') ? 'webm' : mime.includes('mp4') ? 'mp4' : 'm4a';
    const base = safeName(info.basic_info?.title);
    const filename = `${base}.${ext}`;
    const isAudio = type === 'audio';

    // Try to stream from googlevideo with Range support.
    // If anything fails, redirect (302) to the direct URL so the client downloads it.
    try {
      const upstream = await fetch(mediaUrl, {
        headers: { 'User-Agent': 'com.google.ios.youtube/19.45.4 (iPhone16,2; U; CPU iOS 17_5_1 like Mac OS X)' },
      });
      if (!upstream.ok || !upstream.body) throw new Error(`upstream ${upstream.status}`);

      res.setHeader('Content-Type', mime);
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      if (upstream.headers.get('content-length')) {
        res.setHeader('Content-Length', upstream.headers.get('content-length'));
      }
      res.setHeader('Cache-Control', 'public, max-age=3600');

      const reader = upstream.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
      res.end();
      return;
    } catch (streamErr) {
      // Fallback: 302 redirect to the direct googlevideo URL.
      // The client's browser/curl will download directly from Google's CDN (very fast).
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.redirect(302, mediaUrl);
      return;
    }
  } catch (e) {
    return sendJson(res, 502, { error: e.message });
  }
}
