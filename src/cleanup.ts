import { rm } from 'node:fs/promises';
import type { Db } from './db.js';

const GRACE_PERIOD_MS = parseInt(process.env.CLEANUP_GRACE_HOURS ?? '2', 10) * 60 * 60 * 1000;

interface StaleClip {
  id: number;
  output_path: string | null;
  source_path: string | null;
  posted_at: string;
}

interface CountRow {
  count: number;
}

export async function runCleanupPass(db: Db): Promise<void> {
  const staleClips = db.getPostedClipsPendingCleanup.all() as StaleClip[];

  for (const clip of staleClips) {
    const postedAt = new Date(clip.posted_at).getTime();
    if (Date.now() - postedAt < GRACE_PERIOD_MS) continue;

    try {
      if (clip.output_path) {
        await rm(clip.output_path, { force: true });
        console.log(`[cleanup] Deleted processed clip: ${clip.output_path}`);
      }

      // Only delete the source video once ALL clips from this job are cleaned up
      if (clip.source_path) {
        const row = db.countActiveClipsForSource.get(clip.source_path) as CountRow | null;
        if ((row?.count ?? 1) === 0) {
          await rm(clip.source_path, { force: true });
          console.log(`[cleanup] Deleted source video: ${clip.source_path}`);
        }
      }

      db.markClipCleaned.run(clip.id);
    } catch (err) {
      console.error(`[cleanup] Failed to clean clip ${clip.id}:`, err);
    }
  }
}

export function startCleanupScheduler(db: Db): void {
  runCleanupPass(db).catch(err => console.error('[cleanup] Initial pass failed:', err));
  setInterval(() => {
    runCleanupPass(db).catch(err => console.error('[cleanup] Pass failed:', err));
  }, 15 * 60 * 1000);
}
