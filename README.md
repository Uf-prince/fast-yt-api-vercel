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

No environment variables are required for most videos. `youtubei.js` + `express` install automatically during build.

> **Important — some videos need cookies.** See [Bypassing "Sign in to confirm you're not a bot"](#bypassing-sign-in-to-confirm-youre-not-a-bot-login_required) below. If `/api/info` returns `needs_auth: true`, set the `YOUTUBE_COOKIE` env var on Render.

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

> **Limitation:** ANDROID_VR (and PO tokens in general) bypass the block for *most* videos, but a small number of high-enforcement videos still return `LOGIN_REQUIRED` from datacenter IPs even with a valid PO token. For those, the only reliable fix is an authenticated session via the `YOUTUBE_COOKIE` env var — see the section below.

## Speed

- `/api/info` responds in ~400-600ms
- `/api/download` streams (or redirects to googlevideo CDN) in ~500ms, then the file downloads at 20-36 MB/s

## Files

```
server.js         # Express server — mounts API handlers, serves landing page, /health + /api/debug
api/_lib.js       # Shared youtubei.js helpers (getClient, extractId, getFormats, pickFormat)
                   # Uses ANDROID_VR client (no PO Token) + optional YOUTUBE_COOKIE for auth
api/info.js       # GET /api/info — metadata + all format URLs (returns needs_auth on bot block)
api/download.js   # GET /api/download — stream or redirect to media file
api/poToken.js    # PO Token (Proof of Origin) minting via bgutils-js (BotGuard) + jsdom
render.yaml       # Render Blueprint (one-click deploy)
package.json      # express + youtubei.js + bgutils-js + jsdom deps, start script
index.html        # Landing page
```

## Notes

- The download endpoint streams from Google's CDN with Range support; if streaming fails it falls back to a 302 redirect to the direct googlevideo URL.
- The googlevideo URLs are IP-bound and expire after ~6 hours. Always fetch fresh URLs via `/api/info` or `/api/download`.
- On Render's free tier the service spins down after 15 min of inactivity; the first request after idle takes ~30-50s to cold-start.

## Bypassing "Sign in to confirm you're not a bot" (LOGIN_REQUIRED)

### Why it happens

YouTube shows **"Sign in to confirm you're not a bot"** (error `LOGIN_REQUIRED`) when an InnerTube request comes from a **datacenter / cloud IP** (Render, Vercel, AWS, GCP, your sandbox, etc.) for a video with **higher PO-Token enforcement**. The block is based on **IP reputation** plus a BotGuard runtime check that fails in a headless Node.js environment.

The ANDROID_VR client + the built-in PO-token minting (via `bgutils-js`) bypass this for **most** videos, but a small number of videos still get blocked. When that happens, `/api/info` returns:

```json
{
  "error": "No playable formats found. Tried: ... LOGIN_REQUIRED ...",
  "needs_auth": true,
  "cookie_set": false,
  "hint": "Set the YOUTUBE_COOKIE env var with cookies from a logged-in YouTube account to bypass the \"not a bot\" block on datacenter IPs. See README."
}
```

`needs_auth: true` + `cookie_set: false` means you need to set the `YOUTUBE_COOKIE` env var.
`needs_auth: true` + `cookie_set: true` means cookies are set but expired/invalid — re-export them.

### The fix — set `YOUTUBE_COOKIE`

The **only reliable** way past the block is to send requests as a **logged-in** YouTube user. This repo reads cookies from the `YOUTUBE_COOKIE` (or `YT_COOKIE`) env var and attaches them to every InnerTube request, so YouTube treats the server as an authenticated client and lifts the `LOGIN_REQUIRED` block regardless of the server's IP.

#### Step 1 — Export cookies from a logged-in browser

1. Open **https://www.youtube.com** in Chrome/Firefox/Edge and make sure you're **signed in**.
2. Open **DevTools** (`F12` or `Ctrl+Shift+I`) → **Application** tab (Chrome/Edge) or **Storage** tab (Firefox) → **Cookies** → `https://www.youtube.com`.
3. You need at minimum these cookies (copy each **Value**):
   - `SAPISID` (or `__Secure-3PAPISID`)
   - `SID`
   - `HSID`
   - `SSID`
   - `APISID`
4. Build a single cookie-header string, semicolon-separated:
   ```
   SAPISID=<value>; SID=<value>; HSID=<value>; SSID=<value>; APISID=<value>
   ```
   *(Easier alternative: install the **"Get cookies.txt LOCALLYS"** Chrome extension, export a `cookies.txt` for youtube.com, then flatten the rows into a `name=value; name=value; ...` string.)*

> **Tip:** You don't strictly need `SAPISIDHASH` — `youtubei.js` computes it automatically from `SAPISID` + the origin. Just include `SAPISID` (or `__Secure-3PAPISID`) plus `SID`, `HSID`, `SSID`, `APISID`.

#### Step 2 — Set the env var on Render

1. Render dashboard → your web service (`umar-yt-api` or whatever you named it) → **Environment** tab.
2. Click **Add Environment Variable**.
3. **Key:** `YOUTUBE_COOKIE`
4. **Value:** paste the full cookie string from Step 1.
5. Click **Save Changes**.
6. Render auto-redeploys. Wait ~1-2 min, then test again:

```
https://your-app.onrender.com/api/info?url=https://youtu.be/w4a_3wYUMr0
```

You should now get a `200` with the full `medias` array. ✅

#### Step 3 (optional) — Set it locally too

```bash
export YOUTUBE_COOKIE='SAPISID=xxxx; SID=yyyy; HSID=zzzz; SSID=...; APISID=...'
npm start
```

### Keeping cookies fresh

YouTube auth cookies (especially `SAPISID`) **expire** — typically after a few weeks, or sooner if you sign out / change password. When they expire you'll see `needs_auth: true` + `cookie_set: true`. Just repeat Step 1 and update the env var on Render. Using a dedicated Google account (not your main one) for this API is recommended.

### Debug endpoint

`GET /api/debug?video=VIDEO_ID` runs a self-check of the PO-token stack (jsdom, bgutils-js, minter) and tries to mint a token. Useful if you want to confirm the BotGuard deps are healthy on Render:

```
https://your-app.onrender.com/api/debug?video=dQw4w9WgXcQ
```
