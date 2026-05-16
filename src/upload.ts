/**
 * Platform upload — stub.
 *
 * TODO: Implement TikTok, Instagram, and YouTube Shorts uploads.
 * See ARCHITECTURE.md §Step 7 for the full two-phase upload patterns
 * and OAuth token refresh strategy.
 *
 * Each platform uses a different auth flow and upload protocol:
 *
 *   YouTube Shorts — resumable upload via googleapis.com
 *   TikTok         — Content Posting API v2 (requires developer app approval)
 *   Instagram      — Graph API v21+ (requires public HTTPS video URL; use S3/R2)
 *
 * When ready, implement uploadYouTubeShort, uploadTikTok, uploadInstagramReel
 * in separate files and call them from postClip() below.
 */

import type { Db } from './db.js';

export async function postClip(clipId: number, db: Db): Promise<void> {
  console.log(`[upload] Clip ${clipId} — upload step not yet implemented.`);

  // Placeholder: mark as posted immediately so the cleanup scheduler runs.
  // Remove this once real platform uploads are wired up.
  db.markClipPosted.run(clipId);
}
