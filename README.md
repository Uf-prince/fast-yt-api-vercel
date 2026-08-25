# ⚡ Fast YT API — Vercel

Fast YouTube download API deployed as Vercel serverless functions. Returns **direct googlevideo.com CDN URLs** (no throttling, 20-36 MB/s) using the `youtubei.js` iOS client.

## Endpoints

### `GET /api/info?url=YOUTUBE_URL`
Returns JSON with title, author, duration, thumbnail, and all available formats (itag, type, quality, ext, mimeType, direct URL).

**Example:**
```
https://your-app.vercel.app/api/info?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ
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
https://your-app.vercel.app/api/download?url=https://youtu.be/dQw4w9WgXcQ&type=audio

# 720p video download
https://your-app.vercel.app/api/download?url=https://youtu.be/dQw4w9WgXcQ&type=video&quality=720
```

## Deploy to Vercel

1. Fork or import this repo to your GitHub.
2. Go to [vercel.com](https://vercel.com) → New Project → Import this repo.
3. Vercel auto-detects the `api/` folder as serverless functions.
4. Click Deploy. Done — you get a `*.vercel.app` URL.

No environment variables needed. The `youtubei.js` dependency installs automatically.

## How it works

Uses `youtubei.js` with the **iOS client** which returns **pre-signed direct googlevideo.com URLs** — these don't need deciphering and bypass YouTube's throttling. Falls back through `IOS → TV → TV_EMBEDDED → ANDROID → WEB_EMBEDDED → WEB` clients.

## Speed

- `/api/info` responds in ~400-600ms
- `/api/download` redirects to googlevideo CDN in ~500ms, then the file downloads at 20-36 MB/s

## Files

```
api/_lib.js       # Shared youtubei.js helpers (getClient, extractId, getFormats, pickFormat)
api/info.js       # GET /api/info — metadata + all format URLs
api/download.js   # GET /api/download — stream or redirect to media file
vercel.json       # Vercel config (maxDuration: 60s)
package.json      # youtubei.js dependency
index.html        # Landing page
```

## Notes

- Vercel free tier: serverless functions have a timeout. The download endpoint handles this by falling back to a 302 redirect to the direct googlevideo URL when streaming would exceed the limit.
- The googlevideo URLs are IP-bound and expire after ~6 hours. Always fetch fresh URLs via `/api/info` or `/api/download`.
