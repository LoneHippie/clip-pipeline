import multer from 'multer';
import path from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';
import { v4 as uuidv4 } from 'uuid';
import { processingQueue } from './queue.js';
import { runPipeline } from './pipeline.js';
import type { Express } from 'express';
import type { Db } from './db.js';

const UPLOADS_DIR = process.env.UPLOADS_DIR ?? './uploads';

function ensureUploadsDir() {
  if (!existsSync(UPLOADS_DIR)) mkdirSync(UPLOADS_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    ensureUploadsDir();
    cb(null, UPLOADS_DIR);
  },
  filename: (_req, file, cb) => {
    const ext   = path.extname(file.originalname);
    const jobId = uuidv4();
    cb(null, `${jobId}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 * 1024 }, // 10 GB
  fileFilter: (_req, file, cb) => {
    const allowed = ['.mp4', '.mov', '.mkv', '.avi', '.webm'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${ext}`));
    }
  },
});

export function registerIngestRoutes(app: Express, db: Db): void {
  // POST /api/upload — receive video file, create job, enqueue processing
  app.post('/api/upload', upload.single('video'), (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: 'No file provided' });
      return;
    }

    const ext    = path.extname(req.file.filename);
    const jobId  = path.basename(req.file.filename, ext);
    const localPath = req.file.path;

    db.insertJob.run(jobId, req.file.originalname, localPath);
    db.updateJobStatus.run('queued', jobId);

    processingQueue.add(() => runPipeline(jobId, localPath, db)).catch(err => {
      console.error(`[ingest] Queue error for job ${jobId}:`, err);
    });

    res.json({ jobId, status: 'queued' });
  });

  // GET /api/jobs — all jobs ordered by upload time (for GUI polling)
  app.get('/api/jobs', (_req, res) => {
    const jobs = db.listJobs.all();
    res.json(jobs);
  });

  // GET /api/jobs/:jobId/clips — clips for a specific job
  app.get('/api/jobs/:jobId/clips', (req, res) => {
    const clips = db.getClipsForJob.all(req.params.jobId as string);
    res.json(clips);
  });
}
