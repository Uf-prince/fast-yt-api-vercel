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
    sendJson(res, 502, { error: e.message });
  }
}
