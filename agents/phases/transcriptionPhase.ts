import { execa } from "execa";
import Groq from "groq-sdk";
import { createReadStream } from "node:fs";
import { unlink } from "node:fs/promises";
import path from "node:path";
import type { Word } from "../../src/types.js";
import type { AgentStreamChunk } from "./types.js";

// verbose_json adds word-level timestamps; the groq-sdk base type omits them
interface VerboseTranscription {
  text: string;
  words?: Array<{ word: string; start?: number; end?: number }>;
}

function getGroqClient(): Groq {
  return new Groq({ apiKey: process.env.GROQ_API_KEY });
}

async function extractClipAudio(
  videoPath: string,
  startSec: number,
  endSec: number,
  outPath: string,
): Promise<void> {
  const duration = endSec - startSec;
  await execa("ffmpeg", [
    "-y",
    "-ss",
    String(Math.max(0, startSec - 0.5)), // 0.5 s pre-roll
    "-i",
    videoPath,
    "-t",
    String(duration + 1.0), // 1 s post-roll
    "-vn", // audio only
    "-ac",
    "1", // mono
    "-ar",
    "16000", // 16 kHz — Whisper's optimal rate
    "-af",
    "loudnorm", // normalise levels
    "-c:a",
    "pcm_s16le", // uncompressed WAV
    outPath,
  ]);
}

export async function runTranscriptionPhase(
  videoPath: string,
  startSec: number,
  endSec: number,
  tmpDir: string,
  slug: string,
  onChunk?: (chunk: AgentStreamChunk) => void,
): Promise<Word[]> {
  onChunk?.({
    type: "phase-start",
    phase: "transcription",
    text: "Extracting and transcribing audio...",
  });

  const audioPath = path.join(tmpDir, `${slug}_audio.wav`);

  // Extract clip audio via ffmpeg
  onChunk?.({
    type: "tool-call",
    phase: "transcription",
    toolName: "extractClipAudio",
    input: { videoPath, startSec, endSec, outPath: audioPath },
  });
  await extractClipAudio(videoPath, startSec, endSec, audioPath);
  onChunk?.({
    type: "tool-result",
    phase: "transcription",
    output: { audioPath },
  });

  // Transcribe with Groq Whisper
  onChunk?.({
    type: "tool-call",
    phase: "transcription",
    toolName: "groqWhisper",
    input: { audioPath, model: "whisper-large-v3-turbo" },
  });

  const groq = getGroqClient();
  const transcription = (await groq.audio.transcriptions.create({
    file: createReadStream(audioPath),
    model: "whisper-large-v3-turbo",
    response_format: "verbose_json",
    timestamp_granularities: ["word"],
    language: "en",
    temperature: 0,
  })) as unknown as VerboseTranscription;

  // Offset Whisper timestamps (relative to audio file start) to absolute source-video time
  const words: Word[] = (transcription.words ?? []).map((w) => ({
    word: w.word,
    start: parseFloat(((w.start ?? 0) + startSec).toFixed(3)),
    end: parseFloat(((w.end ?? 0) + startSec).toFixed(3)),
  }));

  onChunk?.({
    type: "tool-result",
    phase: "transcription",
    output: { wordCount: words.length },
  });

  // Clean up temp audio file
  await unlink(audioPath).catch(() => {});

  onChunk?.({
    type: "phase-complete",
    phase: "transcription",
    text: `Transcribed ${words.length} words.`,
  });
  return words;
}
