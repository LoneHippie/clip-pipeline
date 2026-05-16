import { execa } from 'execa';
import { writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { Word } from './types.js';

function toSrtTime(secs: number): string {
  const h  = Math.floor(secs / 3600);
  const m  = Math.floor((secs % 3600) / 60);
  const s  = Math.floor(secs % 60);
  const ms = Math.round((secs % 1) * 1000);
  return [
    String(h).padStart(2, '0'),
    String(m).padStart(2, '0'),
    String(s).padStart(2, '0'),
  ].join(':') + ',' + String(ms).padStart(3, '0');
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
    w => w.start >= clipStartSec - 0.1 && w.end <= clipEndSec + 0.1
  );

  const blocks: Word[][] = [];
  let current: Word[] = [];

  for (const w of clipWords) {
    if (current.length > 0) {
      const first = current[0];
      if (first) {
        const blockDuration = w.end - first.start;
        if (current.length >= wordsPerCaption || blockDuration > maxCaptionDuration) {
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
      const last  = block[block.length - 1];
      if (!first || !last) return '';
      // Convert to clip-relative time (SRT starts from 0 for this clip)
      const start = Math.max(0, first.start - clipStartSec);
      const end   = last.end - clipStartSec;
      const text  = block.map(w => w.word).join(' ');
      return `${i + 1}\n${toSrtTime(start)} --> ${toSrtTime(end)}\n${text}`;
    })
    .filter(Boolean)
    .join('\n\n');
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

  // Escape the SRT path for the subtitles filter — colons break on Windows paths
  // but on Linux/Docker this is straightforward
  const escapedSrt = srtPath.replace(/\\/g, '/').replace(/:/g, '\\:');

  await execa('ffmpeg', [
    '-y',
    '-ss', String(ss),
    '-i',  videoPath,
    '-t',  String(duration + 1),
    '-vf', [
      // Center-crop to 9:16
      'crop=ih*9/16:ih:(iw-ih*9/16)/2:0',
      // Scale to 1080×1920
      'scale=1080:1920:flags=lanczos',
      // Burn subtitles — libass must be compiled into ffmpeg
      `subtitles=${escapedSrt}:force_style='Fontname=Arial,Fontsize=18,Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Outline=2,MarginV=120'`,
    ].join(','),
    '-af',       'loudnorm=I=-14:TP=-1.5:LRA=11',
    '-c:v',      'libx264',
    '-preset',   'fast',
    '-crf',      '23',
    '-c:a',      'aac',
    '-b:a',      '192k',
    '-movflags', '+faststart',
    outputPath,
  ]);

  await unlink(srtPath).catch(() => {});
  return outputPath;
}
