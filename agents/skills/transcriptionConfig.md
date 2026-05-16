# Transcription Configuration

## Groq Whisper settings

- **Model**: `whisper-large-v3-turbo` — best speed/accuracy for English content
- **Response format**: `verbose_json` — required for word-level timestamps
- **Timestamp granularity**: `word` — must be set alongside `verbose_json`
- **Language**: `en` — set explicitly to skip language detection latency
- **Temperature**: `0` — deterministic output; no sampling

## Audio extraction (ffmpeg)

Extract audio from the clip window ONLY — never transcribe the full source video.

ffmpeg flags:
- `-ss <startSec - 0.5>` — 0.5 s pre-roll buffer to avoid missing the first word
- `-t <duration + 1.0>` — 1 s post-roll buffer
- `-vn` — strip video stream
- `-ac 1` — mono (Whisper works best with mono)
- `-ar 16000` — 16 kHz sample rate (Whisper's native rate)
- `-af loudnorm` — normalize levels before transcription
- `-c:a pcm_s16le` — uncompressed PCM WAV, avoid compression artifacts

## Timestamp offset

Whisper returns timestamps relative to the START of the audio file.
Add `startSec` to every word's `start` and `end` to convert to absolute source-video time.

## Precision

Whisper word timestamps have ±0.1–0.3 s precision. When burning subtitles, add 0.1 s lead-in
to each caption block so subtitles appear slightly before the word is spoken rather than fractionally late.

## File size limits

Groq enforces a 25 MB per-request limit.
A 90-second 16 kHz mono PCM WAV is ~2.8 MB — well within limits. No chunking needed.
