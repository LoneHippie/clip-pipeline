# Pipeline Overview

This is a local video-to-short-form-clip pipeline. Source videos are uploaded via a browser GUI,
processed through a multi-step AI pipeline, reviewed by a human operator, then published to
TikTok, Instagram Reels, and YouTube Shorts.

## Pipeline Steps

1. **Ingest** — operator drops a video file (MP4/MOV/MKV up to 10 GB) in the GUI
2. **Clip Selection** — Gemini 2.5 Flash analyzes the video and picks 3–5 viral clip windows
3. **Transcription** — Groq Whisper produces word-level timestamps for subtitle sync
4. **Processing** — ffmpeg cuts to clip window, reframes 16:9 → 9:16, burns subtitles
5. **Metadata** — Claude Haiku writes platform-native captions, titles, and hashtags
6. **Review** — operator previews each clip in the browser and approves or rejects
7. **Upload** — approved clips are posted to TikTok, Instagram, and YouTube
8. **Cleanup** — source and processed files are deleted 2 hours after posting

## Target Platforms

- **TikTok** — max 10-min, prefers 15–60 s, punchy captions
- **Instagram Reels** — 9:16, up to 90 s, conversational captions, 15–30 hashtags
- **YouTube Shorts** — under 60 s strongly preferred, SEO-optimized title

## Clip Constraints

- Duration: 45–90 seconds
- Aspect ratio: 9:16 (1080×1920)
- Must be fully self-contained — no dangling context
- Audio normalized to –14 LUFS integrated, –1.5 dBTP true peak
