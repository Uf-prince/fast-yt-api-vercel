// api/download.js — GET /api/download?url=URL&type=audio|video&quality=360|720|1080
//
// Resolves a fresh, playable googlevideo URL (the PO-token work in _lib.js
// makes this work on datacenter/cloud IPs) and sends the client to it.
//
// Strategy (in order):
//   1. PRIMARY — 302 redirect to the direct googlevideo URL.
//      The end user's browser (residential IP) downloads straight from
//      Google's CDN with native Range/resume support. This is the most
//      reliable path because YouTube throttles datacenter IPs (Render/Vercel/
//      AWS) after ~a few hundred KB, but does NOT throttle residential IPs.
//   2. FALLBACK — server-side chunked proxy (only if ?proxy=1 is passed).
//      Streams the file in 256KB bounded Range requests, refreshing the
//      googlevideo URL when it 403s (each URL serves ~a few hundred KB from
//      a datacenter IP before throttling). Slow but works headlessly.
import { getClient, extractId, getFormats, pickFormat, safeName, sendJson } from './_lib.js';

const IOS_UA = 'com.google.ios.youtube/19.45.4 (iPhone16,2; U; CPU iOS 17_5_1 like Mac OS X)';
const CHUNK = 256 * 1024; // 256 KiB — safely under googlevideo's per-request cap.
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function contentLengthFromUrl(u) {
  try {
    const m = String(u).match(/[?&]clen=(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  const url = req.query.url;
  if (!url) return sendJson(res, 400, { error: 'missing url param' });

  const id = extractId(url);
  if (!id) return sendJson(res, 400, { error: 'could not parse video id from url' });

  const type = (req.query.type || 'video').toLowerCase();
  const quality = req.query.quality || '';
  const wantProxy = String(req.query.proxy || '') === '1';

  try {
    const { info, resolved } = await getFormats(id);
    const picked = pickFormat(resolved, type, quality);
    if (!picked) return sendJson(res, 404, { error: `no ${type} format found` });

    const mediaUrl = picked.url;
    const mime = picked.f.mime_type || (type === 'audio' ? 'audio/mp4' : 'video/mp4');
    const ext = mime.includes('webm') ? 'webm' : mime.includes('mp4') ? 'mp4' : 'm4a';
    const base = safeName(info.basic_info?.title);
    const filename = `${base}.${ext}`;

    // ── PRIMARY: redirect to the direct googlevideo URL ──────────────────────
    // The browser (residential IP) handles the download with full Range/resume.
    if (!wantProxy) {
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return res.redirect(302, mediaUrl);
    }

    // ── FALLBACK: server-side chunked proxy (only with ?proxy=1) ─────────────
    const total = picked.f.content_length || contentLengthFromUrl(mediaUrl) || null;
    if (total == null) {
      // Unknown size → can't chunk safely, redirect instead.
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.redirect(302, mediaUrl);
    }

    let start = 0;
    let end = total - 1;
    const rm = (req.headers['range'] || '').match(/bytes=(\d*)-(\d*)/);
    if (rm) {
      if (rm[1]) start = parseInt(rm[1], 10);
      if (rm[2]) end = Math.min(parseInt(rm[2], 10), total - 1);
    }
    if (start > end || start >= total) start = 0;

    const partLen = end - start + 1;
    const isPartial = start > 0 || end < total - 1;

    res.status(isPartial ? 206 : 200);
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', String(partLen));
    if (isPartial) res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=3600');

    let cur = start;
    let currentUrl = mediaUrl;
    let refreshes = 0;
    let consecutiveFails = 0;

    while (cur <= end) {
      const chunkEnd = Math.min(cur + CHUNK - 1, end);
      const r = await fetch(currentUrl, {
        headers: { 'User-Agent': IOS_UA, 'Range': `bytes=${cur}-${chunkEnd}` },
      });

      if (!r.ok || !r.body || r.status >= 400) {
        consecutiveFails++;
        // Refresh the googlevideo URL (the old one got throttled) and retry
        // the same chunk. Abort after too many refreshes.
        if (refreshes < 15) {
          refreshes++;
          try {
            const fresh = await getFormats(id);
            const fp = pickFormat(fresh.resolved, type, quality);
            if (fp?.url) currentUrl = fp.url;
          } catch {}
          await sleep(800);
          continue;
        }
        if (consecutiveFails > 20) {
          console.error('[download] proxy: too many failures, aborting');
          break;
        }
        await sleep(1200);
        continue;
      }

      consecutiveFails = 0;
      try {
        const reader = r.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      } catch (writeErr) {
        // Client disconnected.
        break;
      }
      cur = chunkEnd + 1;
      await sleep(150); // gentle pacing between chunks
    }

    try { res.end(); } catch {}
    return;
  } catch (e) {
    if (!res.headersSent) return sendJson(res, 502, { error: e.message });
    try { res.end(); } catch {}
    return;
  }
}
