import { execa } from "execa";
import { unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Word } from "./types.js";

function toSrtTime(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  const ms = Math.round((secs % 1) * 1000);
  return (
    [
      String(h).padStart(2, "0"),
      String(m).padStart(2, "0"),
      String(s).padStart(2, "0"),
    ].join(":") +
    "," +
    String(ms).padStart(3, "0")
  );
}

export function generateSrt(
  words: Word[],
  clipStartSec: number,
  clipEndSec: number,
  wordsPerCaption = 6,
  maxCaptionDuration = 3.0,
): string {
  // Filter to words within this clip's window (with small tolerance)
  const clipWords = words.filter(
    (w) => w.start >= clipStartSec - 0.1 && w.end <= clipEndSec + 0.1,
  );

  const blocks: Word[][] = [];
  let current: Word[] = [];

  for (const w of clipWords) {
    if (current.length > 0) {
      const first = current[0];
      if (first) {
        const blockDuration = w.end - first.start;
        if (
          current.length >= wordsPerCaption ||
          blockDuration > maxCaptionDuration
        ) {
          blocks.push(current);
          current = [];
        }
      }
    }
    current.push(w);
  }
  if (current.length > 0) blocks.push(current);

  return blocks
    .map((block, i) => {
      const first = block[0];
      const last = block[block.length - 1];
      if (!first || !last) return "";
      // Convert to clip-relative time (SRT starts from 0 for this clip)
      const start = Math.max(0, first.start - clipStartSec);
      const end = last.end - clipStartSec;
      const text = block.map((w) => w.word).join(" ");
      return `${i + 1}\n${toSrtTime(start)} --> ${toSrtTime(end)}\n${text}`;
    })
    .filter(Boolean)
    .join("\n\n");
}

// Re-maps each segment's words from absolute source timestamps onto a
// 0-based composite timeline so generateSrt can treat them as one clip.
export function normalizeCompositeWords(
  segments: Array<{ words: Word[]; startSec: number; endSec: number }>,
): Word[] {
  const normalized: Word[] = [];
  let offset = 0;
  for (const { words, startSec, endSec } of segments) {
    for (const w of words) {
      normalized.push({
        word: w.word,
        start: w.start - startSec + offset,
        end: w.end - startSec + offset,
      });
    }
    offset += endSec - startSec;
  }
  return normalized;
}

// Builds a single output clip by fast-seeking to each segment independently,
// then splicing with filter_complex in one ffmpeg pass.
export async function processCompositeClipFull(
  videoPath: string,
  segments: Array<{ startSec: number; endSec: number }>,
  normalizedWords: Word[], // already on the 0-based composite timeline
  outputPath: string,
  tmpDir: string,
  slug: string,
): Promise<string> {
  const n = segments.length;
  const totalDuration = segments.reduce(
    (sum, s) => sum + s.endSec - s.startSec,
    0,
  );

  const srtPath = path.join(tmpDir, `${slug}.srt`);
  const srtContent = generateSrt(normalizedWords, 0, totalDuration);
  await writeFile(srtPath, srtContent, "utf8");

  // One -ss/-t/-i per segment for fast, accurate seeking
  const inputArgs: string[] = [];
  for (const seg of segments) {
    const ss = Math.max(0, seg.startSec - 0.5);
    const dur = seg.endSec - seg.startSec + 1.0;
    inputArgs.push("-ss", String(ss), "-t", String(dur), "-i", videoPath);
  }

  // filter_complex: per-segment trim (removes the 0.5s pre-roll), crop, scale;
  // then concat all streams; then apply subtitles + audio processing.
  const filterParts: string[] = [];

  for (let i = 0; i < n; i++) {
    const segDur = segments[i]!.endSec - segments[i]!.startSec;
    filterParts.push(
      `[${i}:v]trim=start=0.5:duration=${segDur},setpts=PTS-STARTPTS,` +
        `crop=ih*9/16:ih:(iw-ih*9/16)/2:0,scale=1080:1920:flags=lanczos[v${i}]`,
    );
    filterParts.push(
      `[${i}:a]atrim=start=0.5:duration=${segDur},asetpts=PTS-STARTPTS[a${i}]`,
    );
  }

  const concatInputs = Array.from(
    { length: n },
    (_, i) => `[v${i}][a${i}]`,
  ).join("");
  filterParts.push(`${concatInputs}concat=n=${n}:v=1:a=1[cat_v][cat_a]`);

  const escapedSrt = srtPath.replace(/\\/g, "/").replace(/:/g, "\\:");
  filterParts.push(
    `[cat_v]subtitles=${escapedSrt}:force_style='Fontname=Arial,Fontsize=18,Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Outline=2,MarginV=120'[outv]`,
  );
  filterParts.push(
    `[cat_a]asetrate=sample_rate*1.0595,aresample=44100,atempo=0.9439,loudnorm=I=-14:TP=-1.5:LRA=11[outa]`,
  );

  await execa("ffmpeg", [
    "-y",
    ...inputArgs,
    "-filter_complex",
    filterParts.join(";"),
    "-map",
    "[outv]",
    "-map",
    "[outa]",
    "-c:v",
    "libx264",
    "-preset",
    "fast",
    "-crf",
    "23",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-movflags",
    "+faststart",
    outputPath,
  ]);

  await unlink(srtPath).catch(() => {});
  return outputPath;
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
  const srtPath = path.join(tmpDir, `${slug}.srt`);
  const srtContent = generateSrt(words, startSec, endSec);
  await writeFile(srtPath, srtContent, "utf8");

  const duration = endSec - startSec;
  const ss = Math.max(0, startSec - 0.5);

  // Escape the SRT path for the subtitles filter — colons break on Windows paths
  // but on Linux/Docker this is straightforward
  const escapedSrt = srtPath.replace(/\\/g, "/").replace(/:/g, "\\:");

  await execa("ffmpeg", [
    "-y",
    "-ss",
    String(ss),
    "-i",
    videoPath,
    "-t",
    String(duration + 1),
    "-vf",
    [
      // Center-crop to 9:16
      "crop=ih*9/16:ih:(iw-ih*9/16)/2:0",
      // Scale to 1080×1920
      "scale=1080:1920:flags=lanczos",
      // Burn subtitles — libass must be compiled into ffmpeg
      `subtitles=${escapedSrt}:force_style='Fontname=Arial,Fontsize=18,Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Outline=2,MarginV=120'`,
    ].join(","),
    "-af",
    // Raise pitch by 1 semitone (2^(1/12) ≈ 1.0595) without changing duration.
    // asetrate reinterprets the sample rate to shift pitch up, aresample restores
    // the output to 44100 Hz, and atempo (1/1.0595 ≈ 0.9439) stretches time back.
    "asetrate=sample_rate*1.0595,aresample=44100,atempo=0.9439,loudnorm=I=-14:TP=-1.5:LRA=11",
    "-c:v",
    "libx264",
    "-preset",
    "fast",
    "-crf",
    "23",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-movflags",
    "+faststart",
    outputPath,
  ]);

  await unlink(srtPath).catch(() => {});
  return outputPath;
}
