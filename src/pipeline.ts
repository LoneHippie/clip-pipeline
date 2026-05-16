import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { Db } from "./db.js";
import { generateMetadata } from "./metadata.js";
import { processClipFull } from "./process.js";
import { selectClips } from "./selectClips.js";
import { transcribeClipFromVideo } from "./transcribe.js";

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

      const insertResult = db.insertClip.run(
        jobId,
        clip.title,
        clip.startSec,
        clip.endSec,
      );
      const clipId = Number(insertResult.lastInsertRowid);

      try {
        log(`Clip ${i + 1}/${clips.length}: transcribing "${clip.title}"...`);
        const words = await transcribeClipFromVideo(
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
