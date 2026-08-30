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
