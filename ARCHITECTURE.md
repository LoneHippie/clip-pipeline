# Local Video Auto-Clip Pipeline — Architecture

> **Claude Code context:** This is a TypeScript pipeline with a web-based GUI for human-in-the-loop review. Read this document completely before writing any code. All AI calls use the Vercel AI SDK (`ai` package). The runtime is Node.js 20+. The backend is an Express/Fastify HTTP server running on the VPS that serves both the REST API and the frontend GUI. No GitHub Actions polling — ingestion is triggered manually via the GUI.

---

## Overview

A pipeline that accepts local video files (uploaded via a drag-and-drop GUI), uses Gemini to intelligently select the best short-form clips, uses Groq Whisper for acoustic word-level transcription of clip segments, processes them into platform-ready 9:16 vertical video via ffmpeg, and queues them for human review before uploading to TikTok, Instagram Reels, and YouTube Shorts. Videos that have been successfully posted are automatically deleted from the VPS 2 hours after posting to conserve disk space.

### Human-in-the-Loop Review Flow

```
User drops video file in GUI
        ↓
Pipeline processes video → generates clips
        ↓
Clips appear in GUI review queue (status: "pending_review")
        ↓
Operator previews clip in browser, approves or rejects
        ↓
Approved clips are posted to platforms
        ↓
2 hours after successful post → video file deleted from VPS
```

### Hybrid AI Strategy

| Role | Model | Why |
|---|---|---|
| Clip selection | Gemini 2.5 Flash (via Vercel AI SDK) | Native video file understanding — sees visuals, not just audio |
| Word timestamps | Groq Whisper (`whisper-large-v3-turbo`) | Real acoustic detection for subtitle sync. Gemini's word timestamps are interpolated and unusable. |
| Metadata generation | Claude Haiku (via Vercel AI SDK) | Per-platform captions, titles, hashtags |

### Cost Profile (4 clips/day, ~45-min source videos)

| Component | Cost/month |
|---|---|
| Gemini 2.5 Flash (clip selection) | ~$1.50 |
| Groq Whisper (clip audio only, not full video) | ~$0.05 |
| Claude Haiku (metadata) | ~$0.30 |
| VPS — Express + ffmpeg | ~$5.50 |
| **Total** | **~$7–8/month** |

---

## Project Structure

```
clip-pipeline/
├── .env                          # API keys — never commit
├── src/
│   ├── server.ts                 # Express server — API routes + static file serving
│   ├── ingest.ts                 # Step 1: Accept uploaded video file, validate, enqueue
│   ├── selectClips.ts            # Step 2: Gemini clip selection via local file upload
│   ├── transcribe.ts             # Step 3: ffmpeg audio extraction + Groq Whisper
│   ├── process.ts                # Step 4: ffmpeg cut, reframe, subtitle burn
│   ├── metadata.ts               # Step 5: Claude Haiku per-platform metadata
│   ├── upload.ts                 # Step 6: TikTok / Instagram / YouTube Shorts
│   ├── cleanup.ts                # Step 7: Delete posted video files after 2-hour grace period
│   ├── queue.ts                  # In-process job queue (p-queue) with status tracking
│   ├── db.ts                     # SQLite state management (better-sqlite3)
│   └── types.ts                  # Shared TypeScript interfaces
├── public/
│   ├── index.html                # GUI — drag-and-drop upload + review queue
│   ├── app.js                    # Frontend JS — polling, clip preview, approve/reject
│   └── style.css
├── package.json
├── tsconfig.json
└── ARCHITECTURE.md
```

---

## Shared Types (`src/types.ts`)

Define these first. Every step imports from here.

```typescript
export type JobStatus =
  | 'uploading'
  | 'queued'
  | 'selecting_clips'
  | 'processing'
  | 'pending_review'   // waiting for human approval in GUI
  | 'approved'         // operator approved — ready to post
  | 'rejected'         // operator rejected — will not post
  | 'posting'
  | 'posted'
  | 'failed';

export interface VideoJob {
  jobId: string;           // UUID — internal tracking
  originalFilename: string;
  localPath: string;       // absolute path on VPS where file was saved
  uploadedAt: string;      // ISO timestamp
  status: JobStatus;
}

export interface ClipSelection {
  title: string;
  startSec: number;        // float seconds
  endSec: number;
  hook: string;            // first line / attention grabber
  viralityReason: string;
}

export interface Word {
  word: string;
  start: number;           // float seconds, absolute to source video
  end: number;
}

export interface ProcessedClip {
  clipId: number;          // SQLite clips.id
  selection: ClipSelection;
  words: Word[];
  outputPath: string;      // path to finished 9:16 mp4
  previewUrl: string;      // served by Express — e.g. /clips/preview/42
  metadata?: PlatformMetadata;
}

export interface PlatformMetadata {
  tiktok: {
    caption: string;
    hashtags: string[];
  };
  instagram: {
    caption: string;
    hashtags: string[];
  };
  youtubeShorts: {
    title: string;
    description: string;
    tags: string[];
  };
}
```

---

## Dependencies (`package.json`)

```json
{
  "name": "clip-pipeline",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "dev": "tsx src/server.ts",
    "build": "tsc",
    "start": "node dist/server.js"
  },
  "dependencies": {
    "ai": "^4.x",
    "@ai-sdk/google": "^1.x",
    "@ai-sdk/anthropic": "^1.x",
    "groq-sdk": "^0.x",
    "zod": "^3.x",
    "better-sqlite3": "^9.x",
    "dotenv": "^16.x",
    "p-queue": "^8.x",
    "execa": "^9.x",
    "express": "^4.x",
    "multer": "^1.x",
    "uuid": "^10.x"
  },
  "devDependencies": {
    "@types/node": "^20.x",
    "@types/better-sqlite3": "^7.x",
    "@types/express": "^4.x",
    "@types/multer": "^1.x",
    "@types/uuid": "^10.x",
    "tsx": "^4.x",
    "typescript": "^5.x"
  }
}
```

**Runtime requirements on VPS:**
- `ffmpeg` and `ffprobe` in PATH (install via `apt install ffmpeg`)
- Node.js 20+

**Key library notes:**
- `ai` + `@ai-sdk/google` — Vercel AI SDK for Gemini. Use `generateObject` with a Zod schema so clip selections come back type-safe.
- `@ai-sdk/anthropic` — same SDK, different provider, for Claude Haiku metadata.
- `groq-sdk` — official Groq client for Whisper transcription. Does **not** go through the Vercel AI SDK (no audio transcription support there).
- `better-sqlite3` — synchronous SQLite, simpler than `sqlite3` async for this use case.
- `execa` — typed, promise-based subprocess wrapper for ffmpeg calls.
- `p-queue` — replaces `p-limit`; manages the processing queue with concurrency control and pause/resume support.
- `express` — serves the GUI static files and all REST API routes.
- `multer` — handles `multipart/form-data` file uploads from the browser drag-and-drop widget.
- `uuid` — generates unique job IDs.

---

## Step 1 — Video Ingest (`src/ingest.ts`)

**Goal:** Accept video files uploaded from the GUI, validate them, save to a designated directory on the VPS, and enqueue for processing.

**Libraries:** `multer`, `uuid`, `better-sqlite3`, `node:fs/promises`

**How it works:** The Express server exposes a `POST /api/upload` endpoint. The frontend sends the file as `multipart/form-data`. `multer` writes the file to the VPS `uploads/` directory. A job record is created in SQLite and the job is pushed into the processing queue. The GUI polls `GET /api/jobs` to show live status.

```typescript
// src/ingest.ts
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import path from 'node:path';
import { createDb } from './db.js';
import { processingQueue } from './queue.js';
import type { Express } from 'express';

const UPLOADS_DIR = process.env.UPLOADS_DIR ?? '/var/clip-pipeline/uploads';
const DB_PATH     = process.env.DB_PATH ?? './pipeline.db';

const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (_req, file, cb) => {
    const ext   = path.extname(file.originalname);
    const jobId = uuidv4();
    cb(null, `${jobId}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 * 1024 }, // 10 GB max
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

export function registerIngestRoutes(app: Express): void {
  const db = createDb(DB_PATH);

  // POST /api/upload — accept video file from GUI
  app.post('/api/upload', upload.single('video'), (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: 'No file provided' });
      return;
    }

    const jobId = path.basename(req.file.filename, path.extname(req.file.filename));
    const localPath = req.file.path;

    db.insertJob.run(jobId, req.file.originalname, localPath);
    processingQueue.add(() => runPipeline(jobId, localPath, db));

    res.json({ jobId, status: 'queued' });
  });

  // GET /api/jobs — returns all jobs with status, for GUI polling
  app.get('/api/jobs', (_req, res) => {
    const jobs = db.listJobs.all();
    res.json(jobs);
  });

  // GET /api/jobs/:jobId/clips — returns processed clips for a specific job
  app.get('/api/jobs/:jobId/clips', (req, res) => {
    const clips = db.getClipsForJob.all(req.params.jobId);
    res.json(clips);
  });
}
```

**Key notes:**
- `multer.diskStorage` with a UUID filename ensures no collisions and makes the jobId derivable from the filename.
- Set an appropriate `fileSize` limit for your VPS disk capacity. A 45-min 1080p mp4 is ~1.5–3 GB. Monitor disk usage with a cron health check.
- `fileFilter` rejects unsupported formats before they hit disk — fail fast.

---

## Step 2 — Gemini Clip Selection (`src/selectClips.ts`)

**Goal:** Identify the 3–5 best clip windows from the local video file using Gemini's multimodal video understanding. The local file is uploaded to the Gemini File API, processed, then the file handle is deleted. Returns clip timestamps as `MM:SS` strings — convert to float seconds immediately.

**Libraries:** `ai`, `@ai-sdk/google`, `zod`, `node:fs`

**Important change from YouTube URL approach:** Gemini cannot access files on your VPS directly. You must upload the video to the Gemini File API first using the `@google/generative-ai` file upload utility, get back a `fileUri`, and pass that URI to `generateObject`. Delete the Gemini-hosted file afterwards to avoid accumulating storage.

```typescript
// src/selectClips.ts
import { generateObject } from 'ai';
import { google } from '@ai-sdk/google';
import { GoogleAIFileManager } from '@google/generative-ai/server';
import { z } from 'zod';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import type { ClipSelection } from './types.js';

const fileManager = new GoogleAIFileManager(process.env.GOOGLE_GENERATIVE_AI_API_KEY!);

const ClipSchema = z.object({
  clips: z.array(z.object({
    title:          z.string().describe('Short punchy clip title, max 60 chars'),
    start:          z.string().describe('Start time as MM:SS — e.g. "02:34"'),
    end:            z.string().describe('End time as MM:SS — e.g. "03:18"'),
    hook:           z.string().describe('Opening sentence that grabs attention'),
    viralityReason: z.string().describe('Why this works as a standalone short'),
  })).min(1).max(5),
});

function parseMmSs(ts: string): number {
  const [m, s] = ts.split(':');
  return parseInt(m, 10) * 60 + parseFloat(s);
}

export async function selectClips(
  localVideoPath: string,
  videoTitle: string,
): Promise<ClipSelection[]> {
  // 1. Upload video to Gemini File API
  const mimeType = localVideoPath.endsWith('.mov') ? 'video/quicktime' : 'video/mp4';
  const uploadResponse = await fileManager.uploadFile(localVideoPath, {
    mimeType,
    displayName: path.basename(localVideoPath),
  });

  // 2. Wait for Gemini to finish processing the file (state transitions to ACTIVE)
  let file = await fileManager.getFile(uploadResponse.file.name);
  while (file.state === 'PROCESSING') {
    await new Promise(r => setTimeout(r, 5_000));
    file = await fileManager.getFile(uploadResponse.file.name);
  }
  if (file.state === 'FAILED') {
    throw new Error(`Gemini file processing failed for ${localVideoPath}`);
  }

  // 3. Run clip selection against the uploaded file
  const { object } = await generateObject({
    model: google('gemini-2.5-flash'),
    schema: ClipSchema,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'file',
          data: file.uri,
          mimeType,
        },
        {
          type: 'text',
          text: `You are an expert short-form video editor.

Analyze this video and identify the 3–5 best clips for social media (TikTok, Instagram Reels, YouTube Shorts).

Video title: ${videoTitle}

Rules:
- Each clip must be 45–90 seconds long
- Must be fully self-contained (no dangling context)
- Start on a strong hook: surprising claim, bold opinion, or emotional moment
- End at a natural pause or conclusion — never mid-sentence
- Prefer: strong opinions, surprising facts, actionable advice, emotional peaks
- Avoid: jargon without setup, dead air at start, mid-explanation clips
- Return start/end as MM:SS only — do NOT return word-level timestamps`,
        },
      ],
    }],
  });

  // 4. Delete the file from Gemini's servers — do not accumulate storage
  await fileManager.deleteFile(uploadResponse.file.name).catch(() => {
    // Non-fatal — Gemini auto-expires files after 48h anyway
    console.warn(`[selectClips] Failed to delete Gemini file: ${uploadResponse.file.name}`);
  });

  // 5. Parse and validate timestamps
  return object.clips.map(clip => {
    const startSec = parseMmSs(clip.start);
    const endSec   = parseMmSs(clip.end);
    const duration = endSec - startSec;

    if (duration < 30 || duration > 120) {
      throw new Error(`Clip "${clip.title}" has invalid duration: ${duration}s`);
    }

    return {
      title:          clip.title,
      startSec,
      endSec,
      hook:           clip.hook,
      viralityReason: clip.viralityReason,
    } satisfies ClipSelection;
  });
}
```

**Key notes:**
- `fileManager.uploadFile` streams the file — it does not buffer the whole video into memory. Large files (2–3 GB) are fine.
- The `PROCESSING` polling loop is mandatory. Gemini processes video files asynchronously; calling `generateObject` before the file reaches `ACTIVE` state returns an error.
- Add `@google/generative-ai` to your dependencies: `npm install @google/generative-ai`.
- Always delete the Gemini-hosted file after use. Gemini auto-expires files after 48 hours, but proactive deletion is cleaner and avoids hitting storage quotas.
- Always validate `duration` bounds after parsing. Gemini occasionally returns inverted or equal timestamps.

---

## Step 3 — Audio Extraction + Groq Whisper (`src/transcribe.ts`)

**Goal:** Get real, acoustically-grounded word-level timestamps for subtitle sync. Run Whisper **only on the clip audio segments**, not the full video. A 90-second clip is ~2.8MB of 16kHz mono WAV — well under Groq's 25MB limit, transcribes in ~1–2 seconds.

**Libraries:** `groq-sdk`, `execa`, `node:fs`, `node:path`

**Why not Vercel AI SDK here:** The Vercel AI SDK does not support audio transcription. Use the `groq-sdk` directly for Whisper calls.

### 3a — Extract clip audio window

```typescript
// src/transcribe.ts
import { execa } from 'execa';
import Groq from 'groq-sdk';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import type { Word } from './types.js';

export async function extractClipAudio(
  videoPath: string,
  startSec: number,
  endSec: number,
  outPath: string,
): Promise<string> {
  const duration = endSec - startSec;

  await execa('ffmpeg', [
    '-y',
    '-ss', String(Math.max(0, startSec - 0.5)), // 0.5s pre-roll buffer
    '-i', videoPath,
    '-t', String(duration + 1.0),
    '-vn',                                        // audio only
    '-ac', '1',                                   // mono
    '-ar', '16000',                               // 16kHz — Whisper's optimal sample rate
    '-af', 'loudnorm',                            // normalize audio levels
    '-c:a', 'pcm_s16le',                          // 16-bit PCM WAV
    outPath,
  ]);

  return outPath;
}
```

### 3b — Transcribe with Groq Whisper

```typescript
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

export async function transcribeClip(
  audioPath: string,
  offsetSec: number = 0,
): Promise<Word[]> {
  const transcription = await groq.audio.transcriptions.create({
    file: createReadStream(audioPath),
    model: 'whisper-large-v3-turbo',
    response_format: 'verbose_json',
    timestamp_granularities: ['word'],
    language: 'en',
    temperature: 0,
  });

  return (transcription.words ?? []).map(w => ({
    word:  w.word,
    start: parseFloat((w.start + offsetSec).toFixed(3)),
    end:   parseFloat((w.end   + offsetSec).toFixed(3)),
  }));
}

export async function transcribeClipFromVideo(
  videoPath: string,
  startSec: number,
  endSec: number,
  tmpDir: string,
  clipSlug: string,
): Promise<Word[]> {
  const audioPath = path.join(tmpDir, `${clipSlug}_audio.wav`);
  await extractClipAudio(videoPath, startSec, endSec, audioPath);
  return transcribeClip(audioPath, startSec);
}
```

**Key notes:**
- `timestamp_granularities: ['word']` requires `response_format: 'verbose_json'` — these must be set together.
- Use `whisper-large-v3-turbo` unless the content is non-English or heavily accented.
- Groq's word timestamps have ±0.1–0.3s precision. Add 0.1s lead-in per caption block to avoid subtitles appearing fractionally late.
- Groq has a 25MB per-request limit. A 90-second 16kHz mono WAV is ~2.8MB — no chunking needed.

---

## Step 4 — ffmpeg Processing (`src/process.ts`)

**Goal:** Cut the source video to the clip window, reframe from 16:9 to 9:16, burn subtitles from Whisper word timestamps, normalize audio. One ffmpeg pass.

**Libraries:** `execa`, `node:fs/promises`, `node:path`

```typescript
// src/process.ts
import { execa } from 'execa';
import { writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { Word } from './types.js';

function toSrtTime(secs: number): string {
  const h  = Math.floor(secs / 3600);
  const m  = Math.floor((secs % 3600) / 60);
  const s  = Math.floor(secs % 60);
  const ms = Math.round((secs % 1) * 1000);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')},${String(ms).padStart(3,'0')}`;
}

export function generateSrt(
  words: Word[],
  clipStartSec: number,
  clipEndSec: number,
  wordsPerCaption = 6,
  maxCaptionDuration = 3.0,
): string {
  const clipWords = words.filter(
    w => w.start >= clipStartSec - 0.1 && w.end <= clipEndSec + 0.1
  );

  const blocks: Word[][] = [];
  let current: Word[]    = [];

  for (const w of clipWords) {
    if (current.length > 0) {
      const blockDuration = w.end - current[0].start;
      if (current.length >= wordsPerCaption || blockDuration > maxCaptionDuration) {
        blocks.push(current);
        current = [];
      }
    }
    current.push(w);
  }
  if (current.length > 0) blocks.push(current);

  return blocks.map((block, i) => {
    const start = Math.max(0, block[0].start - clipStartSec);
    const end   = block[block.length - 1].end - clipStartSec;
    const text  = block.map(w => w.word).join(' ');
    return `${i + 1}\n${toSrtTime(start)} --> ${toSrtTime(end)}\n${text}`;
  }).join('\n\n');
}

export async function processClipFull(
  videoPath: string,
  startSec: number,
  endSec: number,
  words: Word[],
  outputPath: string,
  tmpDir: string,
  slug: string,
): Promise<string> {
  const srtPath    = path.join(tmpDir, `${slug}.srt`);
  const srtContent = generateSrt(words, startSec, endSec);
  await writeFile(srtPath, srtContent, 'utf8');

  const duration = endSec - startSec;
  const ss       = Math.max(0, startSec - 0.5);

  await execa('ffmpeg', [
    '-y',
    '-ss', String(ss),
    '-i', videoPath,
    '-t', String(duration + 1),
    '-vf', [
      'crop=ih*9/16:ih:(iw-ih*9/16)/2:0',
      'scale=1080:1920:flags=lanczos',
      `subtitles=${srtPath}:force_style='Fontname=Arial,Fontsize=18,Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Outline=2,MarginV=120'`,
    ].join(','),
    '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11',
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '23',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-movflags', '+faststart',
    outputPath,
  ]);

  await unlink(srtPath);
  return outputPath;
}
```

**Key notes:**
- The `subtitles=` filter requires `libass` compiled into ffmpeg — verify with `ffmpeg -filters | grep subtitles`.
- The center-crop `crop=ih*9/16:ih:(iw-ih*9/16)/2:0` works for most content. For talking-head video, implement face-detection-aware cropping using a lightweight face detector (e.g. `@vladmandic/face-api`) on a few keyframes to adjust the crop X offset.
- `-movflags +faststart` reorders MP4 atoms so metadata sits at the front — required for Instagram upload validation.

---

## Step 5 — Claude Metadata Generation (`src/metadata.ts`)

**Goal:** Generate platform-specific titles, captions, and hashtags for each clip. Each platform has different norms.

**Libraries:** `ai`, `@ai-sdk/anthropic`, `zod`

```typescript
// src/metadata.ts
import { generateObject } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { z } from 'zod';
import type { PlatformMetadata } from './types.js';

const MetadataSchema = z.object({
  tiktok: z.object({
    caption:  z.string().max(150).describe('Hook first line. No hashtags in body.'),
    hashtags: z.array(z.string()).max(5).describe('3–5 hashtags with # prefix'),
  }),
  instagram: z.object({
    caption:  z.string().max(300).describe('2–3 sentences ending with a question to drive comments'),
    hashtags: z.array(z.string()).max(15),
  }),
  youtubeShorts: z.object({
    title:       z.string().max(60).describe('SEO title — front-load the keyword, no clickbait'),
    description: z.string().max(200).describe('2–3 sentences with keywords + full video CTA'),
    tags:        z.array(z.string()).max(10),
  }),
});

export async function generateMetadata(
  clipTranscript: string,
  clipTitle: string,
  viralityReason: string,
): Promise<PlatformMetadata> {
  const { object } = await generateObject({
    model: anthropic('claude-haiku-4-5'),
    schema: MetadataSchema,
    messages: [{
      role: 'user',
      content: `Generate platform-specific social media metadata for this clip.

Clip title hint: ${clipTitle}
Why this clip works: ${viralityReason}
Transcript: ${clipTranscript}

Write copy that feels native to each platform. TikTok: punchy and direct. Instagram: conversational with a CTA question. YouTube Shorts: SEO-focused title.`,
    }],
  });

  return object as PlatformMetadata;
}
```

**Key notes:**
- Use `claude-haiku-4-5` — this is a simple structured generation task. Haiku is 10–20× cheaper than Sonnet with equivalent output for metadata copy.
- The `viralityReason` from Gemini is excellent input here — feed it back so metadata reinforces why the clip is compelling.

---

## Step 6 — GUI Review Queue

**Goal:** Allow an operator to preview generated clips in a browser, then approve or reject each one before posting. This is the primary human-in-the-loop control point.

### Backend API Routes (`src/server.ts`)

```typescript
// Review queue endpoints — registered in server.ts

// GET /api/review — return all clips with status 'pending_review'
app.get('/api/review', (_req, res) => {
  const clips = db.getPendingReviewClips.all();
  res.json(clips);
});

// POST /api/review/:clipId/approve — mark clip approved, trigger posting
app.post('/api/review/:clipId/approve', async (req, res) => {
  const clipId = parseInt(req.params.clipId, 10);
  db.updateClipStatus.run('approved', clipId);
  // Fire-and-forget posting — status updates are polled by the GUI
  postClip(clipId).catch(err =>
    console.error(`[upload] Clip ${clipId} failed:`, err)
  );
  res.json({ ok: true });
});

// POST /api/review/:clipId/reject — mark clip rejected, no posting
app.post('/api/review/:clipId/reject', (_req, res) => {
  const clipId = parseInt(req.params.clipId, 10);
  db.updateClipStatus.run('rejected', clipId);
  res.json({ ok: true });
});

// GET /clips/preview/:clipId — stream the processed mp4 for in-browser preview
app.get('/clips/preview/:clipId', (req, res) => {
  const clipId = parseInt(req.params.clipId, 10);
  const clip   = db.getClipById.get(clipId) as { output_path: string } | undefined;
  if (!clip?.output_path) {
    res.status(404).json({ error: 'Clip not found' });
    return;
  }
  res.sendFile(clip.output_path);
});
```

### Frontend GUI (`public/index.html`)

The GUI is a single HTML page served by Express. It has two sections:

**Upload section** — drag-and-drop area and file picker. On drop or select, sends `POST /api/upload` as `multipart/form-data`. Displays job status as the pipeline runs (polling `GET /api/jobs` every 3 seconds).

**Review queue section** — displays all clips with `status = 'pending_review'`. Each clip card shows:
- The clip title and virality reason from Gemini
- An inline `<video>` element pointing to `/clips/preview/:clipId` for in-browser playback
- The generated metadata (captions, hashtags) for each platform
- **Approve** and **Reject** buttons

```html
<!-- Clip card (rendered dynamically by app.js) -->
<div class="clip-card" data-clip-id="{{clipId}}">
  <h3>{{title}}</h3>
  <p class="virality-reason">{{viralityReason}}</p>

  <video src="/clips/preview/{{clipId}}" controls playsinline
         style="width:270px; height:480px;"></video>

  <details>
    <summary>Platform metadata</summary>
    <pre>{{JSON.stringify(metadata, null, 2)}}</pre>
  </details>

  <div class="actions">
    <button class="approve-btn" onclick="approveClip({{clipId}})">✅ Approve</button>
    <button class="reject-btn"  onclick="rejectClip({{clipId}})">❌ Reject</button>
  </div>
</div>
```

```javascript
// public/app.js (relevant excerpt)

async function approveClip(clipId) {
  await fetch(`/api/review/${clipId}/approve`, { method: 'POST' });
  document.querySelector(`[data-clip-id="${clipId}"]`).remove();
}

async function rejectClip(clipId) {
  await fetch(`/api/review/${clipId}/reject`, { method: 'POST' });
  document.querySelector(`[data-clip-id="${clipId}"]`).remove();
}

// Poll for new pending_review clips every 5 seconds
setInterval(async () => {
  const clips = await fetch('/api/review').then(r => r.json());
  renderQueue(clips);
}, 5_000);
```

**Key notes:**
- The `<video>` element previews the final 9:16 processed clip — what will actually be posted. Keep the preview element sized proportionally (e.g. 270×480px or 360×640px) so the reviewer sees the final framing.
- Express's `res.sendFile` supports HTTP range requests, so the `<video>` element can seek within the clip before it finishes buffering.
- Secure the GUI with HTTP Basic Auth or IP allowlisting via nginx — this is an internal ops tool, not a public endpoint.

---

## Step 7 — Platform Upload (`src/upload.ts`)

**Goal:** Upload approved clips to TikTok, Instagram Reels, and YouTube Shorts. Triggered only after operator approval in the GUI.

**Libraries:** `node:fs`, fetch (all via native fetch — no SDK needed)

All three platforms use a **two-phase upload**: initialize to get a URL/ID, PUT file bytes, then publish.

### YouTube Shorts

```typescript
export async function uploadYouTubeShort(
  videoPath: string,
  meta: PlatformMetadata,
  accessToken: string,
): Promise<string> {
  const fileSize = statSync(videoPath).size;

  const initRes = await fetch(
    'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-Upload-Content-Type': 'video/mp4',
        'X-Upload-Content-Length': String(fileSize),
      },
      body: JSON.stringify({
        snippet: {
          title:       meta.youtubeShorts.title,
          description: meta.youtubeShorts.description,
          tags:        meta.youtubeShorts.tags,
          categoryId:  '22',
        },
        status: { privacyStatus: 'public', madeForKids: false },
      }),
    }
  );
  const uploadUrl = initRes.headers.get('Location')!;
  const fileBuffer = await readFile(videoPath);
  const uploadRes  = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(fileSize) },
    body: fileBuffer,
  });

  const data = await uploadRes.json() as { id: string };
  return data.id;
}
```

### TikTok (Content Posting API v2)

```typescript
export async function uploadTikTok(
  videoPath: string,
  meta: PlatformMetadata,
  accessToken: string,
): Promise<string> {
  const fileSize = statSync(videoPath).size;

  const initRes = await fetch(
    'https://open.tiktokapis.com/v2/post/publish/video/init/',
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
      },
      body: JSON.stringify({
        post_info: {
          title:           `${meta.tiktok.caption} ${meta.tiktok.hashtags.join(' ')}`,
          privacy_level:   'PUBLIC_TO_EVERYONE',
          disable_duet:    false,
          disable_comment: false,
        },
        source_info: {
          source:            'FILE_UPLOAD',
          video_size:        fileSize,
          chunk_size:        fileSize,
          total_chunk_count: 1,
        },
      }),
    }
  );
  const { data } = await initRes.json() as { data: { upload_url: string; publish_id: string } };
  const fileBuffer = await readFile(videoPath);
  await fetch(data.upload_url, {
    method: 'PUT',
    headers: { 'Content-Range': `bytes 0-${fileSize - 1}/${fileSize}`, 'Content-Type': 'video/mp4' },
    body: fileBuffer,
  });

  return data.publish_id;
}
```

### Instagram Reels (Graph API)

```typescript
// Instagram requires the video to be at a public HTTPS URL before submission.
// Upload the processed clip to S3/R2 first, then pass the public URL to the Graph API.
export async function uploadInstagramReel(
  publicVideoUrl: string,
  meta: PlatformMetadata,
  accessToken: string,
  igUserId: string,
): Promise<string> {
  const caption = `${meta.instagram.caption}\n\n${meta.instagram.hashtags.join(' ')}`;

  const containerRes = await fetch(
    `https://graph.facebook.com/v21.0/${igUserId}/media`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        media_type: 'REELS', video_url: publicVideoUrl, caption, access_token: accessToken,
      }),
    }
  );
  const { id: creationId } = await containerRes.json() as { id: string };

  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise(r => setTimeout(r, 10_000));
    const statusRes  = await fetch(
      `https://graph.facebook.com/v21.0/${creationId}?fields=status_code&access_token=${accessToken}`
    );
    const { status_code } = await statusRes.json() as { status_code: string };
    if (status_code === 'FINISHED') break;
    if (status_code === 'ERROR') throw new Error('Instagram container processing failed');
  }

  const pubRes = await fetch(
    `https://graph.facebook.com/v21.0/${igUserId}/media_publish`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ creation_id: creationId, access_token: accessToken }),
    }
  );
  const { id } = await pubRes.json() as { id: string };
  return id;
}
```

**Key notes:**
- **TikTok Creator API** requires a separate developer app approval (apply early, takes 1–2 weeks). Use the Content Posting API v2, not the deprecated v1.
- **Instagram Reels** requires a public HTTPS URL. Add an upload step to S3 or Cloudflare R2 before the Instagram call. R2 has a generous free tier (10GB storage, 1M ops/month).
- **YouTube OAuth tokens** expire after 1 hour. Implement token refresh and store refresh tokens encrypted at rest.

---

## Step 8 — Automatic Cleanup (`src/cleanup.ts`)

**Goal:** Delete the source video file and processed clip files from the VPS 2 hours after a clip has been successfully posted to all platforms. This prevents disk exhaustion while giving operators time to verify the post went live.

**Libraries:** `node:fs/promises`, `better-sqlite3`

```typescript
// src/cleanup.ts
import { rm } from 'node:fs/promises';
import { createDb } from './db.js';

const DB_PATH        = process.env.DB_PATH ?? './pipeline.db';
const GRACE_PERIOD_MS = 2 * 60 * 60 * 1000; // 2 hours in milliseconds

export async function runCleanupPass(): Promise<void> {
  const db = createDb(DB_PATH);

  // Find clips posted more than 2 hours ago whose files haven't been deleted yet
  const staleClips = db.getPostedClipsPendingCleanup.all() as Array<{
    id: number;
    output_path: string;
    source_path: string;
    posted_at: string;
  }>;

  for (const clip of staleClips) {
    const postedAt = new Date(clip.posted_at).getTime();
    if (Date.now() - postedAt < GRACE_PERIOD_MS) continue;

    try {
      // Delete processed clip mp4
      if (clip.output_path) {
        await rm(clip.output_path, { force: true });
        console.log(`[cleanup] Deleted processed clip: ${clip.output_path}`);
      }

      // Delete source video (only after ALL clips from this job are cleaned up)
      const remainingClips = db.countActiveClipsForSource.get(clip.source_path) as { count: number };
      if (remainingClips.count === 0 && clip.source_path) {
        await rm(clip.source_path, { force: true });
        console.log(`[cleanup] Deleted source video: ${clip.source_path}`);
      }

      db.markClipCleaned.run(clip.id);
    } catch (err) {
      console.error(`[cleanup] Failed to delete files for clip ${clip.id}:`, err);
      // Non-fatal — will retry on next cleanup pass
    }
  }
}

// Run cleanup every 15 minutes
export function startCleanupScheduler(): void {
  setInterval(runCleanupPass, 15 * 60 * 1000);
  runCleanupPass(); // also run immediately on startup
}
```

**Key notes:**
- The cleanup pass runs on a 15-minute interval inside the Express server process — no external cron needed.
- Source videos are only deleted once **all** clips derived from them have been cleaned up. This avoids deleting a source file while another clip from the same video is still pending review.
- `rm({ force: true })` silently succeeds if the file no longer exists — safe for idempotent retries.
- The 2-hour grace period is configurable via `CLEANUP_GRACE_HOURS` env var if you want to adjust it.

---

## Step 9 — State Management (`src/db.ts`)

**Goal:** Track pipeline state to avoid reprocessing, enable retries, power the GUI review queue, and track cleanup.

**Libraries:** `better-sqlite3`

```typescript
// src/db.ts
import Database from 'better-sqlite3';

export function createDb(dbPath: string) {
  const db = new Database(dbPath);

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
      metadata_json   TEXT,           -- JSON blob of PlatformMetadata
      status          TEXT DEFAULT 'processing',
                                      -- processing | pending_review | approved | rejected
                                      -- posting | posted | failed | cleaned
      error           TEXT,
      created_at      TEXT DEFAULT (datetime('now')),
      posted_at       TEXT,
      cleaned_at      TEXT
    );

    CREATE TABLE IF NOT EXISTS uploads (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      clip_id      INTEGER NOT NULL REFERENCES clips(id),
      platform     TEXT NOT NULL,     -- tiktok | instagram | youtube_shorts
      post_id      TEXT,
      status       TEXT DEFAULT 'pending',
      uploaded_at  TEXT,
      error        TEXT
    );
  `);

  return {
    // Jobs
    insertJob:        db.prepare(`INSERT INTO jobs (job_id, filename, source_path) VALUES (?, ?, ?)`),
    updateJobStatus:  db.prepare(`UPDATE jobs SET status = ?, updated_at = datetime('now') WHERE job_id = ?`),
    listJobs:         db.prepare(`SELECT * FROM jobs ORDER BY uploaded_at DESC`),

    // Clips
    insertClip:       db.prepare(`INSERT INTO clips (job_id, title, start_sec, end_sec) VALUES (?, ?, ?, ?)`),
    updateClipStatus: db.prepare(`UPDATE clips SET status = ? WHERE id = ?`),
    updateClipOutput: db.prepare(`UPDATE clips SET output_path = ?, metadata_json = ?, status = 'pending_review' WHERE id = ?`),
    getClipById:      db.prepare(`SELECT * FROM clips WHERE id = ?`),
    getClipsForJob:   db.prepare(`SELECT * FROM clips WHERE job_id = ?`),

    // Review queue
    getPendingReviewClips: db.prepare(`
      SELECT c.*, j.source_path FROM clips c
      JOIN jobs j ON c.job_id = j.job_id
      WHERE c.status = 'pending_review'
      ORDER BY c.created_at ASC
    `),

    // Uploads
    insertUpload:     db.prepare(`INSERT INTO uploads (clip_id, platform, post_id, status, uploaded_at) VALUES (?, ?, ?, ?, datetime('now'))`),
    markClipPosted:   db.prepare(`UPDATE clips SET status = 'posted', posted_at = datetime('now') WHERE id = ?`),

    // Cleanup
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
    markClipCleaned: db.prepare(`UPDATE clips SET status = 'cleaned', cleaned_at = datetime('now') WHERE id = ?`),
  };
}
```

---

## Main Pipeline Entry Point (`src/server.ts`)

Wires all steps together. The Express server handles ingest, serves the GUI, exposes review queue endpoints, and starts the cleanup scheduler.

```typescript
// src/server.ts
import 'dotenv/config';
import express          from 'express';
import path             from 'node:path';
import pQueue           from 'p-queue';
import { registerIngestRoutes } from './ingest.js';
import { selectClips }          from './selectClips.js';
import { transcribeClipFromVideo } from './transcribe.js';
import { processClipFull }      from './process.js';
import { generateMetadata }     from './metadata.js';
import { startCleanupScheduler } from './cleanup.js';
import { createDb }             from './db.js';

const app     = express();
const DB_PATH = process.env.DB_PATH ?? './pipeline.db';
const TMP_DIR = process.env.TMP_DIR  ?? '/tmp/clips';
const PORT    = parseInt(process.env.PORT ?? '3000', 10);

app.use(express.json());
app.use(express.static(path.join(import.meta.dirname, '../public')));

// Processing queue — max 1 video at a time to avoid OOM on VPS
export const processingQueue = new pQueue({ concurrency: 1 });

registerIngestRoutes(app);

export async function runPipeline(jobId: string, localPath: string, db: ReturnType<typeof createDb>) {
  db.updateJobStatus.run('selecting_clips', jobId);

  try {
    const filename = path.basename(localPath);
    const clips    = await selectClips(localPath, filename);

    db.updateJobStatus.run('processing', jobId);

    for (let i = 0; i < clips.length; i++) {
      const clip    = clips[i];
      const slug    = `${jobId}_clip${i}`;
      const outPath = path.join(TMP_DIR, `${slug}.mp4`);

      const clipId = (db.insertClip.run(jobId, clip.title, clip.startSec, clip.endSec) as { lastInsertRowid: number }).lastInsertRowid;

      const words      = await transcribeClipFromVideo(localPath, clip.startSec, clip.endSec, TMP_DIR, slug);
      await processClipFull(localPath, clip.startSec, clip.endSec, words, outPath, TMP_DIR, slug);

      const transcript = words.map(w => w.word).join(' ');
      const metadata   = await generateMetadata(transcript, clip.title, clip.viralityReason);

      // Clip is ready — move to pending_review for operator approval
      db.updateClipOutput.run(outPath, JSON.stringify(metadata), clipId);
      console.log(`[pipeline] Clip ${i + 1}/${clips.length} ready for review: "${clip.title}"`);
    }

    db.updateJobStatus.run('pending_review', jobId);

  } catch (err) {
    console.error(`[pipeline] Job ${jobId} failed:`, err);
    db.updateJobStatus.run('failed', jobId);
    throw err;
  }
}

// Start cleanup scheduler on server boot
startCleanupScheduler();

app.listen(PORT, () => {
  console.log(`[server] Clip pipeline running on http://localhost:${PORT}`);
});
```

---

## Environment Variables (`.env`)

```bash
# AI APIs
GOOGLE_GENERATIVE_AI_API_KEY=...   # Gemini + Gemini File API
GROQ_API_KEY=...                   # Groq Whisper
ANTHROPIC_API_KEY=...              # Claude Haiku

# Platform OAuth tokens (refresh regularly)
YOUTUBE_ACCESS_TOKEN=...
YOUTUBE_REFRESH_TOKEN=...
TIKTOK_ACCESS_TOKEN=...
INSTAGRAM_ACCESS_TOKEN=...
IG_USER_ID=...

# Pipeline config
DB_PATH=./pipeline.db
UPLOADS_DIR=/var/clip-pipeline/uploads
TMP_DIR=/tmp/clips
PORT=3000
CLEANUP_GRACE_HOURS=2              # hours before posted videos are deleted
```

---

## OAuth Token Refresh Strategy

Platform access tokens expire. Build a `refreshTokens.ts` module that:

1. Runs on a daily cron (VPS cron) or is called lazily before each upload
2. Uses each platform's refresh token endpoint to get a new access token
3. Updates the `.env` file or writes to a secrets manager

```typescript
// Pseudocode — implement per platform
async function refreshYouTubeToken(refreshToken: string): Promise<string> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({
      client_id:     process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      refresh_token: refreshToken,
      grant_type:    'refresh_token',
    }),
  });
  const { access_token } = await res.json() as { access_token: string };
  return access_token;
}
```

---

## Error Handling & Retry Strategy

- **Step 2 (Gemini file upload + selection):** Retry the full upload + selection 2×. If both fail, mark job `failed` and surface in the GUI.
- **Step 3 (Whisper):** Retry 1×. Groq is highly reliable.
- **Step 4 (ffmpeg):** Log stderr on failure. No auto-retry — usually a bad timestamp or missing codec. Mark clip `failed`.
- **Step 7 (upload):** Use `Promise.allSettled` — a TikTok failure should not block a YouTube upload. Log each platform result independently. A clip is marked `posted` only when at least one platform upload succeeds.
- **Cleanup:** Non-fatal — failed file deletions are retried on the next 15-minute cleanup pass.

---

## Deployment

### VPS Setup (Hetzner CX22 — $6/month, 2 vCPU / 4GB RAM)

```bash
# Install runtime dependencies
apt update && apt install -y ffmpeg nodejs npm

# Create upload + tmp directories
mkdir -p /var/clip-pipeline/uploads /tmp/clips

# Clone repo and install
git clone <your-repo> clip-pipeline
cd clip-pipeline
npm install
cp .env.example .env  # fill in API keys

# Run server (use PM2 or systemd for production)
npm install -g pm2
pm2 start --name clip-pipeline -- npm start
pm2 save
pm2 startup
```

### Securing the GUI

The review GUI is an internal operations tool. Secure it before exposing to the internet:

```nginx
# /etc/nginx/sites-available/clip-pipeline
server {
    listen 443 ssl;
    server_name clips.yourdomain.com;

    # Basic Auth for GUI access
    auth_basic "Clip Pipeline";
    auth_basic_user_file /etc/nginx/.htpasswd;

    location / {
        proxy_pass http://localhost:3000;
    }
}
```

Generate credentials: `htpasswd -c /etc/nginx/.htpasswd youroperatorname`

Alternatively, restrict by IP allowlist if your team has static IPs:

```nginx
allow 1.2.3.4;   # your office/VPN IP
deny all;
```
