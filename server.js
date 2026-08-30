// server.js — Express server for Render (long-running)
// Wraps the original Vercel-style api/*.js handlers so we don't rewrite logic.
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

import infoHandler from './api/info.js';
import downloadHandler from './api/download.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy (Render sits behind a reverse proxy) — needed for correct req.protocol / IPs
app.set('trust proxy', 1);

// Basic middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// A tiny Vercel-compat shim: Express already provides req.query,
// res.status().json(), res.setHeader(), res.write(), res.end(), res.redirect().
// So the existing handlers run unmodified.

// --- API routes ---
app.get('/api/info', (req, res) => infoHandler(req, res));
app.get('/api/download', (req, res) => downloadHandler(req, res));

// Allow HEAD on download (some clients prefetch)
app.head('/api/download', (req, res) => downloadHandler(req, res));

// Health check for Render
app.get('/health', (req, res) => res.status(200).json({ ok: true, ts: Date.now() }));

// Diagnostic endpoint — per-client format resolution breakdown.
// Usage: GET /api/diag?video=VIDEO_ID
import { extractId, getClientWithPoTokenExposed } from './api/_lib.js';
import { getPoTokenForVideo } from './api/poToken.js';
import { Innertube } from 'youtubei.js';
app.get('/api/diag', async (req, res) => {
  const vid = extractId(req.query.url) || req.query.video || 'dQw4w9WgXcQ';
  const out = { ts: Date.now(), video: vid, clients: [] };
  try {
    const YOUTUBE_COOKIE_LOCAL = process.env.YOUTUBE_COOKIE || process.env.YT_COOKIE || true;
    const clients = YOUTUBE_COOKIE_LOCAL ? ['WEB','WEB_EMBEDDED','TV','TV_EMBEDDED','ANDROID_VR','IOS','ANDROID'] : ['TV','TV_EMBEDDED','ANDROID_VR','IOS','ANDROID','WEB','WEB_EMBEDDED'];
    let yt;
    try { yt = await getClientWithPoTokenExposed(); } catch (e) { out.getClientError = e.message; }
    // Cookie-free client for mobile/VR clients (web cookies cause 400 on IOS/etc).
    let ytMobile = null;
    try { ytMobile = await Innertube.create({ retrieve_player: true, enable_session_cache: false, generate_session_locally: true }); } catch (e) { out.mobileClientError = e.message; }
    const player = yt?.session?.player;
    const mobilePlayer = ytMobile?.session?.player;
    const contentPoToken = await getPoTokenForVideo(vid).catch(() => null);
    for (const client of clients) {
      const c = { client };
      try {
        let info; let dp = player;
        const isWeb = (client === 'WEB' || client === 'WEB_EMBEDDED');
        if (isWeb && YOUTUBE_COOKIE_LOCAL) {
          const freshYt = await Innertube.create({ retrieve_player: true, enable_session_cache: false, generate_session_locally: false, cookie: YOUTUBE_COOKIE_LOCAL === true ? undefined : YOUTUBE_COOKIE_LOCAL });
          info = await freshYt.getBasicInfo(vid, client);
          dp = freshYt.session?.player || dp;
        } else if (isWeb && yt) {
          info = await yt.getBasicInfo(vid, { client });
        } else if (ytMobile) {
          info = await ytMobile.getBasicInfo(vid, { client, poToken: contentPoToken || undefined });
          dp = mobilePlayer || dp;
        } else {
          c.error = 'no yt client'; out.clients.push(c); continue;
        }
        const sd = info?.streaming_data;
        const raw = [...(sd?.adaptive_formats||[]), ...(sd?.formats||[])];
        const resolved = [];
        for (const f of raw) {
          let u = null;
          try {
            if (f.deciphered_url && typeof f.deciphered_url === 'string') u = f.deciphered_url;
            else if (f.url && typeof f.url === 'string') u = f.url;
            else if (typeof f.decipher === 'function') { const d = f.decipher(dp); u = (d && typeof d.then==='function') ? await d : d; }
            else if (dp && typeof dp.decipher === 'function') { const d = dp.decipher(f); u = (d && typeof d.then==='function') ? await d : d; }
          } catch(e){ u = null; }
          resolved.push({ itag: f.itag, mime: (f.mime_type||'').slice(0,30), h: f.height, hasUrl: !!(f.url && typeof f.url==='string'), hasSig: !!f.signature_cipher, resolved: !!(u && typeof u==='string') });
        }
        c.status = info?.playability_status?.status;
        c.totalFormats = raw.length;
        c.resolvedCount = resolved.filter(r=>r.resolved).length;
        c.dash = !!sd?.dash_manifest_url;
        c.hls = !!sd?.hls_manifest_url;
        c.sample = resolved.slice(0, 5);
      } catch (e) {
        c.error = (e.message || '').slice(0, 150);
      }
      out.clients.push(c);
    }
  } catch (e) {
    out.fatal = e.message;
  }
  res.status(200).json(out);
});

// Diagnostic endpoint — checks that PO-token deps are installed & working.
// Usage: GET /api/debug  or  GET /api/debug?video=VIDEO_ID
app.get('/api/debug', async (req, res) => {
  const out = { ts: Date.now(), node: process.version, platform: process.platform };
  // 1) check deps load
  try {
    const j = await import('jsdom');
    out.jsdom = { ok: true, version: j.JSDOM ? 'loaded' : 'missing' };
  } catch (e) {
    out.jsdom = { ok: false, error: e.message };
  }
  try {
    const b = await import('bgutils-js/botguard');
    out.bgutils = { ok: true, hasGetChallenge: typeof b.getChallenge === 'function' };
  } catch (e) {
    out.bgutils = { ok: false, error: e.message };
  }
  try {
    const w = await import('bgutils-js/webpo');
    out.bgutils_webpo = { ok: true, hasWebPoMinter: typeof w.WebPoMinter === 'function' };
  } catch (e) {
    out.bgutils_webpo = { ok: false, error: e.message };
  }
  // 2) try to mint a PO token
  try {
    const { getPoTokenForVideo } = await import('./api/poToken.js');
    const vid = req.query.video || 'dQw4w9WgXcQ';
    const t0 = Date.now();
    const tok = await getPoTokenForVideo(vid);
    out.poToken = tok
      ? { ok: true, video: vid, len: tok.length, preview: tok.slice(0, 24), ms: Date.now() - t0 }
      : { ok: false, video: vid, ms: Date.now() - t0, note: 'mint returned null (see server logs)' };
  } catch (e) {
    out.poToken = { ok: false, error: e.message, stack: (e.stack || '').split('\n').slice(0, 5) };
  }
  res.status(200).json(out);
});

// --- Landing page (served at root) ---
app.get('/', (req, res) => {
  const file = path.join(__dirname, 'index.html');
  if (fs.existsSync(file)) return res.sendFile(file);
  res.type('text/plain').send('Fast YT API ⚡ — Render');
});

// Catch-all: serve index.html for any non-API GET (mirrors vercel.json routes)
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api/')) {
    const file = path.join(__dirname, 'index.html');
    if (fs.existsSync(file)) return res.sendFile(file);
  }
  next();
});

// 404 for anything else
app.use((req, res) => {
  res.status(404).json({ error: 'not found', path: req.path });
});

app.listen(PORT, () => {
  console.log(`⚡ Fast YT API listening on :${PORT} (Render)`);
});
