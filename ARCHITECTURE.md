# YouTube Auto-Clip Pipeline — Architecture

> **Claude Code context:** This is a fully autonomous TypeScript pipeline. Read this document completely before writing any code. All AI calls use the Vercel AI SDK (`ai` package). The runtime is Node.js 20+. No frontend — this is a pure backend pipeline run via CLI and scheduled via GitHub Actions.

---

## Overview

An autonomous pipeline that monitors YouTube channels for new videos, uses Gemini to intelligently select the best short-form clips (via native video URL understanding), uses Groq Whisper for acoustic word-level transcription of clip segments only, processes them into platform-ready 9:16 vertical video via ffmpeg, and uploads to TikTok, Instagram Reels, and YouTube Shorts.

### Hybrid AI Strategy

| Role | Model | Why |
|---|---|---|
| Clip selection | Gemini 2.5 Flash (via Vercel AI SDK) | Native video URL understanding — sees visuals, not just audio |
| Word timestamps | Groq Whisper (`whisper-large-v3-turbo`) | Real acoustic detection for subtitle sync. Gemini's word timestamps are interpolated and unusable. |
| Metadata generation | Claude Haiku (via Vercel AI SDK) | Per-platform captions, titles, hashtags |

### Cost Profile (4 clips/day, ~45-min source videos)

| Component | Cost/month |
|---|---|
| Gemini 2.5 Flash (clip selection) | ~$1.50 |
| Groq Whisper (clip audio only, not full video) | ~$0.05 |
| Claude Haiku (metadata) | ~$0.30 |
| VPS — n8n + ffmpeg + yt-dlp | ~$5.50 |
| **Total** | **~$7–8/month** |

---

## Project Structure

```
clip-pipeline/
├── .env                          # API keys — never commit
├── .github/
│   └── workflows/
│       └── poll.yml              # GitHub Actions cron (Step 1)
├── src/
│   ├── index.ts                  # Entry point — run full pipeline for one video
│   ├── poll.ts                   # Step 1: RSS feed polling + new video detection
│   ├── download.ts               # Step 2: yt-dlp video download
│   ├── selectClips.ts            # Step 3: Gemini clip selection via YouTube URL
│   ├── transcribe.ts             # Step 4: ffmpeg audio extraction + Groq Whisper
│   ├── process.ts                # Step 5: ffmpeg cut, reframe, subtitle burn
│   ├── metadata.ts               # Step 6: Claude Haiku per-platform metadata
│   ├── upload.ts                 # Step 7: TikTok / Instagram / YouTube Shorts
│   ├── db.ts                     # SQLite state management (better-sqlite3)
│   └── types.ts                  # Shared TypeScript interfaces
├── package.json
├── tsconfig.json
└── ARCHITECTURE.md
```

---

## Shared Types (`src/types.ts`)

Define these first. Every step imports from here.

```typescript
export interface VideoJob {
  videoId: string;
  channelName: string;
  title: string;
  url: string;           // https://www.youtube.com/watch?v=VIDEO_ID
  publishedAt: string;
}

export interface ClipSelection {
  title: string;
  startSec: number;      // float seconds, parsed from Gemini MM:SS output
  endSec: number;
  hook: string;          // first line / attention grabber
  viralityReason: string;
}

export interface Word {
  word: string;
  start: number;         // float seconds, absolute to source video
  end: number;
}

export interface ProcessedClip {
  selection: ClipSelection;
  words: Word[];         // from Groq Whisper — real acoustic timestamps
  outputPath: string;    // path to finished mp4
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
    "dev": "tsx src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "poll": "tsx src/poll.ts"
  },
  "dependencies": {
    "ai": "^4.x",
    "@ai-sdk/google": "^1.x",
    "@ai-sdk/anthropic": "^1.x",
    "groq-sdk": "^0.x",
    "zod": "^3.x",
    "better-sqlite3": "^9.x",
    "fast-xml-parser": "^4.x",
    "dotenv": "^16.x",
    "p-limit": "^6.x",
    "execa": "^9.x"
  },
  "devDependencies": {
    "@types/node": "^20.x",
    "@types/better-sqlite3": "^7.x",
    "tsx": "^4.x",
    "typescript": "^5.x"
  }
}
```

**Runtime requirements on VPS:**
- `ffmpeg` and `ffprobe` in PATH (install via `apt install ffmpeg`)
- `yt-dlp` in PATH (install via `pip install yt-dlp` or download binary)
- Node.js 20+

**Key library notes:**
- `ai` + `@ai-sdk/google` — Vercel AI SDK for Gemini. Use `generateObject` with a Zod schema so clip selections come back type-safe without JSON parsing fragility.
- `@ai-sdk/anthropic` — same SDK, different provider, for Claude Haiku metadata.
- `groq-sdk` — official Groq client for Whisper transcription. Does **not** go through the Vercel AI SDK (no audio transcription support there).
- `better-sqlite3` — synchronous SQLite, simpler than `sqlite3` async for this use case.
- `fast-xml-parser` — parse YouTube Atom RSS feeds without DOM overhead.
- `execa` — typed, promise-based subprocess wrapper for ffmpeg/yt-dlp calls. Better DX than raw `child_process`.
- `p-limit` — concurrency limiter for parallel clip processing.

---

## Step 1 — RSS Polling (`src/poll.ts`)

**Goal:** Detect new videos on watched channels without hitting YouTube Data API quota.

**Libraries:** `fast-xml-parser`, `better-sqlite3`, `node:https` (or `fetch`)

**How it works:** Each YouTube channel has a public Atom feed at `https://www.youtube.com/feeds/videos.xml?channel_id=CHANNEL_ID`. No API key needed. GitHub Actions runs this on a 15-minute cron, compares feed entries against a SQLite `seen` table, and fires a webhook to the VPS for any new video IDs.

```typescript
// src/poll.ts
import { XMLParser } from 'fast-xml-parser';
import Database from 'better-sqlite3';

const CHANNELS: Record<string, string> = {
  'Channel Name': 'UC_CHANNEL_ID_HERE',
};

export async function poll(dbPath: string, webhookUrl: string) {
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE IF NOT EXISTS seen (
    vid TEXT PRIMARY KEY,
    channel TEXT,
    detected_at TEXT
  )`);

  const parser = new XMLParser({ ignoreAttributes: false });
  const insert = db.prepare(`INSERT OR IGNORE INTO seen VALUES (?, ?, datetime('now'))`);
  const exists = db.prepare(`SELECT 1 FROM seen WHERE vid = ?`);

  for (const [name, channelId] of Object.entries(CHANNELS)) {
    const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
    const res = await fetch(feedUrl);
    const xml = await res.text();
    const feed = parser.parse(xml);

    const entries = [feed.feed.entry].flat(); // always array
    for (const entry of entries) {
      const vid: string = entry['yt:videoId'];
      if (!exists.get(vid)) {
        insert.run(vid, name);
        await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            videoId: vid,
            channelName: name,
            title: entry.title,
            url: `https://www.youtube.com/watch?v=${vid}`,
            publishedAt: entry.published,
          } satisfies VideoJob),
        });
      }
    }
  }
}
```

```yaml
# .github/workflows/poll.yml
on:
  schedule:
    - cron: '*/15 * * * *'
  workflow_dispatch:

jobs:
  poll:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - uses: actions/cache@v4
        with:
          path: seen.db         # persists SQLite between runs
          key: seen-db-v1
      - run: npm ci
      - run: npm run poll
        env:
          WEBHOOK_URL: ${{ secrets.N8N_WEBHOOK_URL }}
```

**Key notes:**
- The `seen.db` file is persisted between Actions runs via `actions/cache`. Alternative: use Supabase free tier (Postgres) for a remote state store immune to cache eviction.
- Do NOT use the YouTube Data API for polling — `search.list` costs 100 quota units per call against a 10,000/day budget.
- RSS feeds update within ~2 minutes of a video going live.
- `[feed.feed.entry].flat()` handles the edge case where a channel has exactly 1 entry (XML parser returns object, not array).

---

## Step 2 — Video Download (`src/download.ts`)

**Goal:** Download the source video to the VPS for ffmpeg processing.

**Libraries:** `execa`, `node:fs/promises`, `node:path`

**Timing note:** Gemini (Step 3) takes the YouTube URL directly and does not need the local file. Download can be initiated in parallel with the Gemini call to save wall time. Only ffmpeg (Step 5) needs the local file.

```typescript
// src/download.ts
import { execa } from 'execa';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export interface DownloadResult {
  videoPath: string;
  info: Record<string, unknown>; // yt-dlp info JSON (contains chapters, duration, etc.)
}

export async function downloadVideo(
  videoId: string,
  outDir = '/tmp/clips'
): Promise<DownloadResult> {
  const outTemplate = path.join(outDir, `${videoId}.%(ext)s`);

  await execa('yt-dlp', [
    '--format', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
    '--merge-output-format', 'mp4',
    '--output', outTemplate,
    '--write-info-json',       // saves chapters, duration, description
    '--no-playlist',
    '--retries', '5',
    '--fragment-retries', '10',
    '--sleep-interval', '2',   // polite rate limiting
    `https://www.youtube.com/watch?v=${videoId}`,
  ]);

  const videoPath = path.join(outDir, `${videoId}.mp4`);
  const infoPath  = path.join(outDir, `${videoId}.info.json`);
  const info = JSON.parse(await readFile(infoPath, 'utf8').catch(() => '{}'));

  return { videoPath, info };
}
```

**Key notes:**
- Always use `--write-info-json`. The info JSON contains `chapters` — if the source video has chapters, these can be used as free clip boundaries (skip Gemini call for well-structured content).
- Storage: a 45-min 1080p mp4 is ~1.5–3GB. Delete immediately after all uploads complete. Never accumulate on disk.
- For age-restricted content: add `'--cookies-from-browser', 'chrome'` to the args array.
- `execa` throws on non-zero exit codes, so wrap in try/catch for retry logic.

---

## Step 3 — Gemini Clip Selection (`src/selectClips.ts`)

**Goal:** Identify the 3–5 best clip windows from the video using Gemini's multimodal video understanding. Returns clip timestamps as `MM:SS` strings — convert to float seconds immediately. **Do not use Gemini's word-level timestamps** — they are interpolated, not acoustic.

**Libraries:** `ai`, `@ai-sdk/google`, `zod`

**Why `generateObject` over `generateText`:** Gemini's raw output is JSON we need to parse and validate. `generateObject` with a Zod schema enforces type safety at the boundary, throws descriptively if the model output doesn't conform, and eliminates all manual JSON parsing + regex fence stripping.

```typescript
// src/selectClips.ts
import { generateObject } from 'ai';
import { google } from '@ai-sdk/google';
import { z } from 'zod';
import type { ClipSelection } from './types.js';

// Zod schema — the model MUST return this shape
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
  youtubeUrl: string,
  videoTitle: string,
): Promise<ClipSelection[]> {
  const { object } = await generateObject({
    model: google('gemini-2.5-flash'),
    schema: ClipSchema,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'text',
          text: `You are an expert short-form video editor.

Analyze this video and identify the 3–5 best clips for social media (TikTok, Instagram Reels, YouTube Shorts).

Video title: ${videoTitle}
URL: ${youtubeUrl}

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

  // Convert MM:SS strings to float seconds and validate duration
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
- Gemini receives the YouTube URL directly — no local file needed at this step.
- The Zod schema is passed to `generateObject` which uses it as a structured output constraint. The model cannot return malformed JSON.
- Always validate `duration` bounds after parsing. Gemini occasionally returns inverted or equal timestamps.
- Use `gemini-2.5-flash` for cost efficiency. Upgrade to `gemini-2.5-pro` only if selection quality is noticeably poor for your content type.
- The YouTube URL must be publicly accessible. Private or unlisted videos will cause Gemini to return an error.

---

## Step 4 — Audio Extraction + Groq Whisper (`src/transcribe.ts`)

**Goal:** Get real, acoustically-grounded word-level timestamps for subtitle sync. Run Whisper **only on the clip audio segments**, not the full video. A 90-second clip is ~2.8MB of 16kHz mono WAV — well under Groq's 25MB limit, transcribes in ~1–2 seconds.

**Libraries:** `groq-sdk`, `execa`, `node:fs`, `node:path`

**Why not Vercel AI SDK here:** The Vercel AI SDK does not support audio transcription. Use the `groq-sdk` directly for Whisper calls.

### 4a — Extract clip audio window

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
    '-t', String(duration + 1.0),               // slight overshoot, trimmed by Whisper timestamps
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

### 4b — Transcribe with Groq Whisper

```typescript
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

export async function transcribeClip(
  audioPath: string,
  offsetSec: number = 0,  // add this to make timestamps absolute to source video
): Promise<Word[]> {
  const transcription = await groq.audio.transcriptions.create({
    file: createReadStream(audioPath),
    model: 'whisper-large-v3-turbo', // faster + cheaper, minimal accuracy loss for English
    response_format: 'verbose_json',
    timestamp_granularities: ['word'], // word-level only — segment-level not needed here
    language: 'en',
    temperature: 0,
  });

  // transcription.words: Array<{ word: string, start: number, end: number }>
  // Apply the clip's start offset to make timestamps absolute
  return (transcription.words ?? []).map(w => ({
    word:  w.word,
    start: parseFloat((w.start + offsetSec).toFixed(3)),
    end:   parseFloat((w.end   + offsetSec).toFixed(3)),
  }));
}

// Convenience wrapper: extract audio for a clip window, then transcribe it
export async function transcribeClipFromVideo(
  videoPath: string,
  startSec: number,
  endSec: number,
  tmpDir: string,
  clipSlug: string,
): Promise<Word[]> {
  const audioPath = path.join(tmpDir, `${clipSlug}_audio.wav`);
  await extractClipAudio(videoPath, startSec, endSec, audioPath);
  // Pass startSec as offset so returned timestamps are absolute to source video
  return transcribeClip(audioPath, startSec);
}
```

**Key notes:**
- `timestamp_granularities: ['word']` requires `response_format: 'verbose_json'` — these must be set together.
- Use `whisper-large-v3-turbo` unless the content is non-English or heavily accented. It's ~3× faster and ~50% cheaper than `whisper-large-v3` with minimal accuracy difference for English speech.
- Groq's word timestamps have ±0.1–0.3s precision. When generating SRT from these timestamps, add 0.1s lead-in per caption block to avoid subtitles appearing fractionally late.
- Groq has a 25MB per-request limit. A 90-second 16kHz mono WAV is ~2.8MB — comfortably under. No chunking needed at this step since we're only transcribing clip segments.

---

## Step 5 — ffmpeg Processing (`src/process.ts`)

**Goal:** Cut the source video to the clip window, reframe from 16:9 to 9:16, burn subtitles from Whisper word timestamps, normalize audio. One ffmpeg pass — decode and re-encode once.

**Libraries:** `execa`, `node:fs/promises`, `node:path`

### Generate SRT from Whisper words

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
  // Filter to words within the clip window
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

  // SRT timestamps are relative to clip start (not source video)
  return blocks.map((block, i) => {
    const start = Math.max(0, block[0].start - clipStartSec);
    const end   = block[block.length - 1].end - clipStartSec;
    const text  = block.map(w => w.word).join(' ');
    return `${i + 1}\n${toSrtTime(start)} --> ${toSrtTime(end)}\n${text}`;
  }).join('\n\n');
}
```

### ffmpeg cut + reframe + subtitle burn

```typescript
export async function processClip(
  videoPath: string,
  startSec: number,
  endSec: number,
  srtPath: string,
  outputPath: string,
): Promise<string> {
  const duration = endSec - startSec;
  const ss = Math.max(0, startSec - 0.5); // seek before -i for speed

  await execa('ffmpeg', [
    '-y',
    '-ss', String(ss),
    '-i', videoPath,
    '-t', String(duration + 1),

    // Video filter chain — single pass
    '-vf', [
      // 1. Crop center 9:16 from 16:9 source
      'crop=ih*9/16:ih:(iw-ih*9/16)/2:0',
      // 2. Scale to 1080x1920 (standard Short/Reel/TikTok)
      'scale=1080:1920:flags=lanczos',
      // 3. Burn subtitles from SRT
      // force_style controls font, size, outline, position
      `subtitles=${srtPath}:force_style='Fontname=Arial,Fontsize=18,Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Outline=2,MarginV=120'`,
    ].join(','),

    // Audio: normalize to -14 LUFS (TikTok/YouTube standard loudness)
    '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11',

    // Encoding
    '-c:v', 'libx264',
    '-preset', 'fast',   // balance speed vs file size; use 'medium' for better compression
    '-crf', '23',        // quality factor — lower = better quality, larger file
    '-c:a', 'aac',
    '-b:a', '192k',
    '-movflags', '+faststart', // enables streaming before full download (important for uploads)

    outputPath,
  ]);

  return outputPath;
}

// Full convenience wrapper
export async function processClipFull(
  videoPath: string,
  startSec: number,
  endSec: number,
  words: Word[],
  outputPath: string,
  tmpDir: string,
  slug: string,
): Promise<string> {
  const srtPath = path.join(tmpDir, `${slug}.srt`);
  const srtContent = generateSrt(words, startSec, endSec);
  await writeFile(srtPath, srtContent, 'utf8');

  await processClip(videoPath, startSec, endSec, srtPath, outputPath);

  await unlink(srtPath); // cleanup tmp SRT
  return outputPath;
}
```

**Key notes:**
- The `subtitles=` filter requires `libass` compiled into ffmpeg — verify with `ffmpeg -filters | grep subtitles`. Most Linux packages include it; macOS Homebrew does.
- The crop filter `crop=ih*9/16:ih:(iw-ih*9/16)/2:0` is center-crop. For talking-head content, implement face-detection-aware cropping: run `ffprobe` or a lightweight face detector (e.g. the `@vladmandic/face-api` npm package) on a few keyframes to find the average face X position, then adjust the crop X offset accordingly.
- `-movflags +faststart` reorders the MP4 atoms so the metadata sits at the front of the file — required for Instagram's upload validation and improves TikTok upload reliability.
- Target output file size: 1080x1920 at CRF 23 produces ~15–25MB for a 60-second clip. TikTok limit is 287.6MB, Instagram is 100MB, YouTube Shorts is 256MB — all fine.

---

## Step 6 — Claude Metadata Generation (`src/metadata.ts`)

**Goal:** Generate platform-specific titles, captions, and hashtags for each clip. Each platform has different norms — do not use a generic caption everywhere.

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
  clipTranscript: string,   // words joined as plain text
  clipTitle: string,
  channelName: string,
  viralityReason: string,
): Promise<PlatformMetadata> {
  const { object } = await generateObject({
    model: anthropic('claude-haiku-4-5'),
    schema: MetadataSchema,
    messages: [{
      role: 'user',
      content: `Generate platform-specific social media metadata for this clip.

Channel: ${channelName}
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
- Use `claude-haiku-4-5` here — this is a simple structured generation task, not a reasoning task. Haiku is 10–20× cheaper than Sonnet with equivalent output quality for metadata copy.
- `generateObject` with the Zod schema ensures hashtags stay within platform limits and field lengths are respected at the model level.
- The `viralityReason` field from Gemini's output is excellent input here — feed it back to Claude so the metadata reinforces why the clip is compelling.

---

## Step 7 — Platform Upload (`src/upload.ts`)

**Goal:** Upload finished clips and metadata to TikTok, Instagram Reels, and YouTube Shorts.

**Libraries:** `node:fs`, `node:https` (all via `fetch` — no SDK needed for upload APIs)

All three platforms use a **two-phase upload**: initialize the upload to get a URL/ID, then PUT/POST the file bytes, then optionally publish.

### YouTube Shorts

```typescript
// src/upload.ts (YouTube section)
import { createReadStream, statSync } from 'node:fs';
import type { PlatformMetadata } from './types.js';

export async function uploadYouTubeShort(
  videoPath: string,
  meta: PlatformMetadata,
  accessToken: string,
): Promise<string> {
  const fileSize = statSync(videoPath).size;

  // 1. Initiate resumable upload session
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
          categoryId:  '22', // People & Blogs
        },
        status: { privacyStatus: 'public', madeForKids: false },
      }),
    }
  );
  const uploadUrl = initRes.headers.get('Location')!;

  // 2. Upload file bytes via the resumable session URI
  const fileBuffer = await readFileAsBuffer(videoPath);
  const uploadRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Length': String(fileSize),
    },
    body: fileBuffer,
  });

  const data = await uploadRes.json() as { id: string };
  return data.id; // YouTube video ID
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

  // 1. Initialize upload
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
          chunk_size:        fileSize, // single chunk for files <128MB
          total_chunk_count: 1,
        },
      }),
    }
  );
  const { data } = await initRes.json() as { data: { upload_url: string; publish_id: string } };

  // 2. Upload file
  const fileBuffer = await readFileAsBuffer(videoPath);
  await fetch(data.upload_url, {
    method: 'PUT',
    headers: {
      'Content-Range': `bytes 0-${fileSize - 1}/${fileSize}`,
      'Content-Type': 'video/mp4',
    },
    body: fileBuffer,
  });

  return data.publish_id;
}
```

### Instagram Reels (Graph API)

```typescript
// Instagram requires the video to be hosted at a PUBLIC HTTPS URL before submission.
// Upload to S3/R2 first, then pass the public URL to the Graph API.
export async function uploadInstagramReel(
  publicVideoUrl: string,   // must be a public HTTPS URL (S3/R2 signed URL won't work — must be public)
  meta: PlatformMetadata,
  accessToken: string,
  igUserId: string,
): Promise<string> {
  const caption = `${meta.instagram.caption}\n\n${meta.instagram.hashtags.join(' ')}`;

  // 1. Create media container (async processing begins)
  const containerRes = await fetch(
    `https://graph.facebook.com/v21.0/${igUserId}/media`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        media_type:  'REELS',
        video_url:   publicVideoUrl,
        caption,
        access_token: accessToken,
      }),
    }
  );
  const { id: creationId } = await containerRes.json() as { id: string };

  // 2. Poll until container status is FINISHED (Instagram processes async — can take 30–120s)
  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise(r => setTimeout(r, 10_000)); // wait 10s between polls
    const statusRes = await fetch(
      `https://graph.facebook.com/v21.0/${creationId}?fields=status_code&access_token=${accessToken}`
    );
    const { status_code } = await statusRes.json() as { status_code: string };
    if (status_code === 'FINISHED') break;
    if (status_code === 'ERROR') throw new Error(`Instagram container processing failed`);
  }

  // 3. Publish
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

async function readFileAsBuffer(filePath: string): Promise<Buffer> {
  const { readFile } = await import('node:fs/promises');
  return readFile(filePath);
}
```

**Key notes:**
- **TikTok Creator API** requires a separate developer app approval (apply early, takes 1–2 weeks). Use the Content Posting API v2, not the deprecated v1.
- **Instagram Reels** requires the video to be at a public HTTPS URL — not a local path, not a signed URL that requires auth headers. Add an upload step to S3 or Cloudflare R2 before the Instagram call. R2 has a generous free tier (10GB storage, 1M ops/month).
- **YouTube OAuth tokens** expire after 1 hour (access token) but refresh tokens last 6 months if unused. Implement token refresh logic and store refresh tokens encrypted at rest (never plaintext).
- **Rate limits:** TikTok limits to ~100 posts/day per app. Instagram limits vary by account age and standing. YouTube Shorts API has no specific short-form limit but counts against the general upload quota.

---

## Step 8 — State Management (`src/db.ts`)

**Goal:** Track pipeline state to avoid reprocessing, enable retries, and provide observability.

**Libraries:** `better-sqlite3`

```typescript
// src/db.ts
import Database from 'better-sqlite3';

export function createDb(dbPath: string) {
  const db = new Database(dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS seen_videos (
      vid          TEXT PRIMARY KEY,
      channel      TEXT NOT NULL,
      title        TEXT,
      detected_at  TEXT DEFAULT (datetime('now')),
      processed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS clips (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id     TEXT NOT NULL REFERENCES seen_videos(vid),
      title        TEXT,
      start_sec    REAL,
      end_sec      REAL,
      status       TEXT DEFAULT 'pending',  -- pending | processing | done | failed
      output_path  TEXT,
      error        TEXT,
      created_at   TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS uploads (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      clip_id      INTEGER NOT NULL REFERENCES clips(id),
      platform     TEXT NOT NULL,           -- tiktok | instagram | youtube_shorts
      post_id      TEXT,
      status       TEXT DEFAULT 'pending',  -- pending | done | failed
      uploaded_at  TEXT,
      error        TEXT
    );
  `);

  return {
    markSeen:     db.prepare(`INSERT OR IGNORE INTO seen_videos (vid, channel, title) VALUES (?, ?, ?)`),
    markDone:     db.prepare(`UPDATE seen_videos SET processed_at = datetime('now') WHERE vid = ?`),
    insertClip:   db.prepare(`INSERT INTO clips (video_id, title, start_sec, end_sec) VALUES (?, ?, ?, ?)`),
    updateClip:   db.prepare(`UPDATE clips SET status = ?, output_path = ?, error = ? WHERE id = ?`),
    insertUpload: db.prepare(`INSERT INTO uploads (clip_id, platform, post_id, status, uploaded_at) VALUES (?, ?, ?, ?, datetime('now'))`),
    getFailedClips: db.prepare(`SELECT * FROM clips WHERE status = 'failed'`),
  };
}
```

---

## Main Pipeline Entry Point (`src/index.ts`)

Wires all steps together for a single `VideoJob`. This is called by your n8n webhook handler or directly from CLI.

```typescript
// src/index.ts
import 'dotenv/config';
import pLimit from 'p-limit';
import { downloadVideo }        from './download.js';
import { selectClips }          from './selectClips.js';
import { transcribeClipFromVideo } from './transcribe.js';
import { processClipFull }      from './process.js';
import { generateMetadata }     from './metadata.js';
import { uploadYouTubeShort, uploadTikTok, uploadInstagramReel } from './upload.js';
import { createDb }             from './db.js';
import type { VideoJob }        from './types.js';
import { rm }                   from 'node:fs/promises';
import path                     from 'node:path';

const TMP_DIR = '/tmp/clips';
const DB_PATH = process.env.DB_PATH ?? './pipeline.db';
const limit   = pLimit(2); // max 2 clips processed concurrently

export async function runPipeline(job: VideoJob): Promise<void> {
  const db = createDb(DB_PATH);
  console.log(`[pipeline] Starting: ${job.videoId} — "${job.title}"`);

  try {
    // Step 2 and Step 3 run in parallel — Gemini doesn't need the local file
    const [{ videoPath }, clips] = await Promise.all([
      downloadVideo(job.videoId, TMP_DIR),
      selectClips(job.url, job.title),
    ]);

    console.log(`[pipeline] Gemini selected ${clips.length} clips`);

    // Process each clip (with concurrency limit)
    await Promise.all(clips.map((clip, i) => limit(async () => {
      const slug = `${job.videoId}_clip${i}`;
      const outputPath = path.join(TMP_DIR, `${slug}.mp4`);

      // Step 4: Transcribe clip audio only
      const words = await transcribeClipFromVideo(
        videoPath, clip.startSec, clip.endSec, TMP_DIR, slug
      );

      // Step 5: ffmpeg — cut, reframe, subtitle
      await processClipFull(videoPath, clip.startSec, clip.endSec, words, outputPath, TMP_DIR, slug);

      // Step 6: Generate metadata
      const transcript = words.map(w => w.word).join(' ');
      const meta = await generateMetadata(transcript, clip.title, job.channelName, clip.viralityReason);

      // Step 7: Upload to all platforms
      await Promise.allSettled([
        uploadYouTubeShort(outputPath, meta, process.env.YOUTUBE_ACCESS_TOKEN!),
        uploadTikTok(outputPath, meta, process.env.TIKTOK_ACCESS_TOKEN!),
        // Instagram needs public URL — upload to R2 first (not shown — add R2 upload step here)
        // uploadInstagramReel(publicUrl, meta, process.env.INSTAGRAM_ACCESS_TOKEN!, process.env.IG_USER_ID!),
      ]);

      console.log(`[pipeline] ✓ Clip ${i + 1}/${clips.length}: "${clip.title}"`);
    })));

    // Cleanup local files
    await rm(videoPath);
    db.markDone.run(job.videoId);
    console.log(`[pipeline] Done: ${job.videoId}`);

  } catch (err) {
    console.error(`[pipeline] Failed: ${job.videoId}`, err);
    throw err; // let n8n retry handler catch this
  }
}

// CLI usage: tsx src/index.ts VIDEO_ID
if (process.argv[2]) {
  const videoId = process.argv[2];
  runPipeline({
    videoId,
    channelName: 'Manual',
    title: `Video ${videoId}`,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    publishedAt: new Date().toISOString(),
  }).catch(process.exit);
}
```

---

## Environment Variables (`.env`)

```bash
# AI APIs
GOOGLE_GENERATIVE_AI_API_KEY=...   # Gemini — also read by @ai-sdk/google automatically
GROQ_API_KEY=...                   # Groq Whisper
ANTHROPIC_API_KEY=...              # Claude Haiku — also read by @ai-sdk/anthropic automatically

# Platform OAuth tokens (refresh regularly — see notes in upload.ts)
YOUTUBE_ACCESS_TOKEN=...
YOUTUBE_REFRESH_TOKEN=...
TIKTOK_ACCESS_TOKEN=...
INSTAGRAM_ACCESS_TOKEN=...
IG_USER_ID=...

# Pipeline config
DB_PATH=./pipeline.db
N8N_WEBHOOK_URL=...   # used in poll.ts to trigger VPS
WEBHOOK_SECRET=...    # shared secret to validate incoming webhooks on VPS
```

---

## OAuth Token Refresh Strategy

Platform access tokens expire. Build a `refreshTokens.ts` module that:

1. Runs on a daily cron (GitHub Actions or VPS cron)
2. Uses each platform's refresh token endpoint to get a new access token
3. Updates the `.env` file or (better) writes to a secrets manager

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

Each step can fail independently. Recommended approach:

- **Step 2 (download):** Retry 3× with exponential backoff. yt-dlp transient errors are common.
- **Step 3 (Gemini):** Retry 2× — Gemini occasionally returns malformed JSON despite `generateObject`. If both retries fail, skip the video and alert.
- **Step 4 (Whisper):** Retry 1×. Groq is highly reliable.
- **Step 5 (ffmpeg):** Log stderr on failure — usually a missing codec or bad timestamp. No auto-retry; requires human investigation.
- **Step 7 (upload):** Use `Promise.allSettled` (already shown in `index.ts`) — a TikTok failure should not block a YouTube upload. Log each platform result independently.

In n8n, set the webhook workflow to retry failed executions up to 3 times with a 5-minute delay. Store failed video IDs in the `clips` table with `status = 'failed'` and a cron job to retry them.

---

## Deployment

### VPS Setup (Hetzner CX22 — $6/month, 2 vCPU / 4GB RAM)

```bash
# Install runtime dependencies
apt update && apt install -y ffmpeg nodejs npm
npm install -g pnpm tsx

# Install yt-dlp
curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
chmod +x /usr/local/bin/yt-dlp

# Clone repo and install
git clone <your-repo> clip-pipeline
cd clip-pipeline
pnpm install
cp .env.example .env  # fill in API keys

# Run n8n via Docker for orchestration
docker run -d --name n8n -p 5678:5678 \
  -v ~/.n8n:/home/node/.n8n \
  docker.n8n.io/n8nio/n8n
```

### n8n Webhook Workflow

1. **Webhook trigger** — receives POST from GitHub Actions poll job
2. **Validate secret header** — reject if `X-Webhook-Secret` doesn't match `WEBHOOK_SECRET`
3. **Execute Command node** — `tsx /path/to/clip-pipeline/src/index.ts {{ $json.videoId }}`
4. **Error trigger** — on failure, send Slack/Telegram alert + write to failed_jobs table
5. **Retry** — configure n8n execution retry: 3 attempts, 5-minute delay
