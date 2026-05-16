import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { Db } from "./db";
import { generateMetadata } from "./metadata";
import {
  normalizeCompositeWords,
  processClipFull,
  processCompositeClipFull,
} from "./process";
import { selectClips } from "./selectClips";
import { transcribeClipFromVideo } from "./transcribe";
import { isCompositeClip } from "./types";

const TMP_DIR = process.env.TMP_DIR ?? "/tmp/clips";

export async function runPipeline(
  jobId: string,
  localPath: string,
  db: Db,
): Promise<void> {
  // Ensure temp directory exists
  if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });

  const log = (msg: string) => console.log(`[pipeline:${jobId}] ${msg}`);

  db.updateJobStatus.run("selecting_clips", jobId);
  log("Selecting clips...");

  try {
    const filename = path.basename(localPath);
    const clips = await selectClips(localPath, filename, (chunk) => {
      if (chunk.type === "phase-start" || chunk.type === "phase-complete") {
        log(chunk.text);
      }
    });

    log(`${clips.length} clips selected. Processing...`);
    db.updateJobStatus.run("processing", jobId);

    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      if (!clip) continue;
      const slug = `${jobId}_clip${i}`;
      const outDir = path.join(TMP_DIR, jobId);
      if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
      const outPath = path.join(outDir, `${slug}.mp4`);

      // For composite clips, record the span from first segment start to last segment end
      const dbStartSec = isCompositeClip(clip)
        ? clip.segments[0]!.startSec
        : clip.startSec;
      const dbEndSec = isCompositeClip(clip)
        ? clip.segments[clip.segments.length - 1]!.endSec
        : clip.endSec;

      const insertResult = db.insertClip.run(
        jobId,
        clip.title,
        dbStartSec,
        dbEndSec,
      );
      const clipId = Number(insertResult.lastInsertRowid);

      try {
        let words: Awaited<ReturnType<typeof transcribeClipFromVideo>>;

        if (isCompositeClip(clip)) {
          log(
            `Clip ${i + 1}/${clips.length}: transcribing ${clip.segments.length} segments for "${clip.title}"...`,
          );
          // Transcribe all segments in parallel, then normalize to composite timeline
          const segmentResults = await Promise.all(
            clip.segments.map((seg) =>
              transcribeClipFromVideo(
                localPath,
                seg.startSec,
                seg.endSec,
                TMP_DIR,
                slug,
              ).then((w) => ({
                words: w,
                startSec: seg.startSec,
                endSec: seg.endSec,
              })),
            ),
          );
          words = normalizeCompositeWords(segmentResults);

          log(`Clip ${i + 1}/${clips.length}: processing composite video...`);
          await processCompositeClipFull(
            localPath,
            clip.segments,
            words,
            outPath,
            TMP_DIR,
            slug,
          );
        } else {
          log(`Clip ${i + 1}/${clips.length}: transcribing "${clip.title}"...`);
          words = await transcribeClipFromVideo(
            localPath,
            clip.startSec,
            clip.endSec,
            TMP_DIR,
            slug,
            (chunk) => {
              if (chunk.type === "phase-complete") log(chunk.text);
            },
          );

          log(`Clip ${i + 1}/${clips.length}: processing video...`);
          await processClipFull(
            localPath,
            clip.startSec,
            clip.endSec,
            words,
            outPath,
            TMP_DIR,
            slug,
          );
        }

        log(`Clip ${i + 1}/${clips.length}: generating metadata...`);
        const transcript = words.map((w) => w.word).join(" ");
        const metadata = await generateMetadata(
          transcript,
          clip.title,
          clip.viralityReason,
        );

        db.updateClipOutput.run(outPath, JSON.stringify(metadata), clipId);
        log(`Clip ${i + 1}/${clips.length} ready for review: "${clip.title}"`);
      } catch (clipErr) {
        const msg =
          clipErr instanceof Error ? clipErr.message : String(clipErr);
        console.error(`[pipeline:${jobId}] Clip ${clipId} failed: ${msg}`);
        db.updateClipError.run(msg, clipId);
      }
    }

    db.updateJobStatus.run("pending_review", jobId);
    log("All clips processed — awaiting review.");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[pipeline:${jobId}] Fatal error: ${msg}`);
    db.updateJobStatus.run("failed", jobId);
    throw err;
  }
}
