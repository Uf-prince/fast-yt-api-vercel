# ⚡ Fast YT API — Render

Fast YouTube download API deployed as a long-running **Express** server on **Render**. Returns **direct googlevideo.com CDN URLs** (no throttling, 20-36 MB/s) using the `youtubei.js` clients (ANDROID_VR primary — no PO Token required, works on datacenter IPs).

> Originally built for Vercel serverless; this version is refactored to run as a standard Node/Express web service so it deploys cleanly on Render (free tier supported).

## Endpoints

### `GET /api/info?url=YOUTUBE_URL`
Returns JSON with title, author, duration, thumbnail, and all available formats (itag, type, quality, ext, mimeType, direct URL).

**Example:**
```
https://your-app.onrender.com/api/info?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ
```

```json
{
  "title": "Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)",
  "author": "Rick Astley",
  "duration": 213,
  "thumbnail": "https://i.ytimg.com/...",
  "medias": [
    { "itag": 251, "type": "audio", "quality": "160kbps", "ext": "webm", "url": "https://...googlevideo.com/..." },
    { "itag": 137, "type": "video", "quality": "1080p", "ext": "mp4", "url": "https://...googlevideo.com/..." }
  ],
  "time_ms": 420
}
```

### `GET /api/download?url=YOUTUBE_URL&type=audio|video&quality=360|720|1080`
Downloads the media file. Streams from Google's CDN, or falls back to a **302 redirect** to the direct googlevideo URL (client downloads at full CDN speed).

| Param | Values | Default |
|-------|--------|---------|
| `url` | Any YouTube URL (watch, youtu.be, shorts, embed) | required |
| `type` | `audio` or `video` | `video` |
| `quality` | `360`, `720`, `1080`, `1440`, `2160` (video only) | best available |

**Examples:**
```
# Audio download
https://your-app.onrender.com/api/download?url=https://youtu.be/dQw4w9WgXcQ&type=audio

# 720p video download
https://your-app.onrender.com/api/download?url=https://youtu.be/dQw4w9WgXcQ&type=video&quality=720
```

### `GET /health`
Health check used by Render's monitoring (`{ "ok": true, "ts": ... }`).

## Deploy to Render

### Option A — Blueprint (one click)
1. Push this repo to your GitHub.
2. In Render dashboard → **New** → **Blueprint** → select this repo.
3. Render reads `render.yaml` and creates the web service automatically.
4. Click **Apply**. Done — you get a `*.onrender.com` URL.

### Option B — Manual
1. Push this repo to your GitHub.
2. Render dashboard → **New** → **Web Service** → connect the repo.
3. Settings:
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Health Check Path:** `/health`
4. Click **Create Web Service**. Done.

No environment variables are required. `youtubei.js` + `express` install automatically during build.

## Run locally
```bash
npm install
npm start          # http://localhost:3000
# or
npm run dev        # auto-reload via node --watch
```

## How it works

`server.js` is an Express app that mounts the original Vercel-style handlers (`api/info.js`, `api/download.js`) as routes. The handlers use the standard `(req, res)` signature with `req.query`, `res.status().json()`, `res.setHeader()`, `res.write()`, `res.end()`, and `res.redirect()` — all natively supported by Express — so no logic changes were needed.

The YouTube engine uses `youtubei.js` with the **ANDROID_VR client** (primary) which returns **direct googlevideo.com URLs** without requiring a PO Token — making it work on datacenter/cloud IPs (like Render). Falls back through `ANDROID_VR → IOS → TV → ANDROID → WEB → TV_EMBEDDED → WEB_EMBEDDED` clients.

> **Why ANDROID_VR?** YouTube blocks datacenter IPs on most clients (IOS, WEB, etc.) with "Sign in to confirm you're not a bot". The ANDROID_VR client is one of the few that doesn't require a PO Token and still returns direct googlevideo CDN URLs. IOS is kept as a fallback since on some IPs it returns pre-signed URLs (no deciphering needed).

## Speed

- `/api/info` responds in ~400-600ms
- `/api/download` streams (or redirects to googlevideo CDN) in ~500ms, then the file downloads at 20-36 MB/s

## Files

```
server.js         # Express server — mounts API handlers, serves landing page, /health check
api/_lib.js       # Shared youtubei.js helpers (getClient, extractId, getFormats, pickFormat)
                   # Uses ANDROID_VR client (no PO Token, works on datacenter IPs)
api/info.js       # GET /api/info — metadata + all format URLs
api/download.js   # GET /api/download — stream or redirect to media file
render.yaml       # Render Blueprint (one-click deploy)
package.json      # express + youtubei.js deps, start script
index.html        # Landing page
```

## Notes

- The download endpoint streams from Google's CDN with Range support; if streaming fails it falls back to a 302 redirect to the direct googlevideo URL.
- The googlevideo URLs are IP-bound and expire after ~6 hours. Always fetch fresh URLs via `/api/info` or `/api/download`.
- On Render's free tier the service spins down after 15 min of inactivity; the first request after idle takes ~30-50s to cold-start.
