import { Database } from 'bun:sqlite';
import { mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';

export function createDb(dbPath: string) {
  // Ensure parent directory exists
  const dir = path.dirname(dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const db = new Database(dbPath, { create: true });

  // WAL mode for better concurrency
  db.exec('PRAGMA journal_mode=WAL;');

  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      job_id       TEXT PRIMARY KEY,
      filename     TEXT NOT NULL,
      source_path  TEXT NOT NULL,
      status       TEXT DEFAULT 'queued',
      uploaded_at  TEXT DEFAULT (datetime('now')),
      updated_at   TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS clips (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id          TEXT NOT NULL REFERENCES jobs(job_id),
      title           TEXT,
      start_sec       REAL,
      end_sec         REAL,
      output_path     TEXT,
      metadata_json   TEXT,
      status          TEXT DEFAULT 'processing',
      error           TEXT,
      created_at      TEXT DEFAULT (datetime('now')),
      posted_at       TEXT,
      cleaned_at      TEXT
    );

    CREATE TABLE IF NOT EXISTS uploads (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      clip_id      INTEGER NOT NULL REFERENCES clips(id),
      platform     TEXT NOT NULL,
      post_id      TEXT,
      status       TEXT DEFAULT 'pending',
      uploaded_at  TEXT,
      error        TEXT
    );
  `);

  return {
    // ── Jobs ──────────────────────────────────────────────────────────────────
    insertJob: db.prepare<void, [string, string, string]>(
      `INSERT INTO jobs (job_id, filename, source_path) VALUES (?, ?, ?)`
    ),
    updateJobStatus: db.prepare<void, [string, string]>(
      `UPDATE jobs SET status = ?, updated_at = datetime('now') WHERE job_id = ?`
    ),
    listJobs: db.prepare(
      `SELECT * FROM jobs ORDER BY uploaded_at DESC`
    ),
    getJobById: db.prepare(
      `SELECT * FROM jobs WHERE job_id = ?`
    ),

    // ── Clips ─────────────────────────────────────────────────────────────────
    insertClip: db.prepare<{ lastInsertRowid: number }, [string, string, number, number]>(
      `INSERT INTO clips (job_id, title, start_sec, end_sec) VALUES (?, ?, ?, ?)`
    ),
    updateClipStatus: db.prepare<void, [string, number]>(
      `UPDATE clips SET status = ? WHERE id = ?`
    ),
    updateClipError: db.prepare<void, [string, number]>(
      `UPDATE clips SET status = 'failed', error = ? WHERE id = ?`
    ),
    updateClipOutput: db.prepare<void, [string, string, number]>(
      `UPDATE clips SET output_path = ?, metadata_json = ?, status = 'pending_review' WHERE id = ?`
    ),
    getClipById: db.prepare(
      `SELECT * FROM clips WHERE id = ?`
    ),
    getClipsForJob: db.prepare(
      `SELECT * FROM clips WHERE job_id = ?`
    ),

    // ── Review queue ──────────────────────────────────────────────────────────
    getPendingReviewClips: db.prepare(`
      SELECT c.*, j.source_path FROM clips c
      JOIN jobs j ON c.job_id = j.job_id
      WHERE c.status = 'pending_review'
      ORDER BY c.created_at ASC
    `),

    // ── Uploads ───────────────────────────────────────────────────────────────
    insertUpload: db.prepare<void, [number, string, string, string]>(
      `INSERT INTO uploads (clip_id, platform, post_id, status, uploaded_at) VALUES (?, ?, ?, ?, datetime('now'))`
    ),
    markClipPosted: db.prepare<void, [number]>(
      `UPDATE clips SET status = 'posted', posted_at = datetime('now') WHERE id = ?`
    ),

    // ── Cleanup ───────────────────────────────────────────────────────────────
    getPostedClipsPendingCleanup: db.prepare(`
      SELECT c.id, c.output_path, j.source_path, c.posted_at
      FROM clips c
      JOIN jobs j ON c.job_id = j.job_id
      WHERE c.status = 'posted' AND c.cleaned_at IS NULL
    `),
    countActiveClipsForSource: db.prepare(`
      SELECT COUNT(*) as count FROM clips c
      JOIN jobs j ON c.job_id = j.job_id
      WHERE j.source_path = ? AND c.cleaned_at IS NULL
    `),
    markClipCleaned: db.prepare<void, [number]>(
      `UPDATE clips SET status = 'cleaned', cleaned_at = datetime('now') WHERE id = ?`
    ),
  };
}

export type Db = ReturnType<typeof createDb>;
