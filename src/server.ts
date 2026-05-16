import express from 'express';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { createDb } from './db.js';
import { registerIngestRoutes } from './ingest.js';
import { postClip } from './upload.js';
import type { ClipRow } from './types.js';

const DB_PATH    = process.env.DB_PATH    ?? './pipeline.db';
const PUBLIC_DIR = path.join(import.meta.dir, '../dist/public');

export function createServer() {
  const app = express();
  const db  = createDb(DB_PATH);

  app.use(express.json());

  // ── Static frontend ────────────────────────────────────────────────────────
  if (existsSync(PUBLIC_DIR)) {
    app.use(express.static(PUBLIC_DIR));
  }

  // ── Ingest routes (upload + job listing) ──────────────────────────────────
  registerIngestRoutes(app, db);

  // ── Review queue ──────────────────────────────────────────────────────────

  app.get('/api/review', (_req, res) => {
    const clips = db.getPendingReviewClips.all() as ClipRow[];
    // Parse metadata_json back to an object for the frontend
    const parsed = clips.map(c => ({
      ...c,
      metadata: c.metadata_json ? JSON.parse(c.metadata_json) : null,
    }));
    res.json(parsed);
  });

  app.post('/api/review/:clipId/approve', (req, res) => {
    const clipId = parseInt(req.params.clipId as string, 10);
    if (isNaN(clipId)) {
      res.status(400).json({ error: 'Invalid clipId' });
      return;
    }
    db.updateClipStatus.run('approved', clipId);
    // Fire-and-forget — status updates are polled by the GUI
    postClip(clipId, db).catch(err =>
      console.error(`[upload] Clip ${clipId} failed:`, err)
    );
    res.json({ ok: true });
  });

  app.post('/api/review/:clipId/reject', (req, res) => {
    const clipId = parseInt(req.params.clipId as string, 10);
    if (isNaN(clipId)) {
      res.status(400).json({ error: 'Invalid clipId' });
      return;
    }
    db.updateClipStatus.run('rejected', clipId);
    res.json({ ok: true });
  });

  // ── Video preview streaming ────────────────────────────────────────────────

  app.get('/clips/preview/:clipId', (req, res) => {
    const clipId = parseInt(req.params.clipId as string, 10);
    if (isNaN(clipId)) {
      res.status(400).json({ error: 'Invalid clipId' });
      return;
    }
    const clip = db.getClipById.get(clipId) as ClipRow | null;
    if (!clip?.output_path || !existsSync(clip.output_path)) {
      res.status(404).json({ error: 'Clip not found' });
      return;
    }
    res.sendFile(clip.output_path);
  });

  // ── SPA catch-all (must be last) ──────────────────────────────────────────
  if (existsSync(PUBLIC_DIR)) {
    app.get('*', (_req, res) => {
      res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
    });
  }

  return { app, db };
}
