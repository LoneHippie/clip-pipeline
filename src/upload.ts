import { statSync } from "node:fs";
import type { Db } from "./db.js";
import type { ClipRow, PlatformMetadata } from "./types.js";

// ── YouTube Shorts ──────────────────────────────────────────────────────────

async function refreshYouTubeToken(): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.YOUTUBE_CLIENT_ID!,
      client_secret: process.env.YOUTUBE_CLIENT_SECRET!,
      refresh_token: process.env.YOUTUBE_REFRESH_TOKEN!,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok)
    throw new Error(
      `YouTube token refresh failed: ${res.status} ${await res.text()}`,
    );
  const { access_token } = (await res.json()) as { access_token: string };
  return access_token;
}

async function uploadYouTubeShort(
  videoPath: string,
  meta: PlatformMetadata,
): Promise<string> {
  const accessToken =
    process.env.YOUTUBE_REFRESH_TOKEN &&
    process.env.YOUTUBE_CLIENT_ID &&
    process.env.YOUTUBE_CLIENT_SECRET
      ? await refreshYouTubeToken()
      : process.env.YOUTUBE_ACCESS_TOKEN!;

  const fileSize = statSync(videoPath).size;

  const initRes = await fetch(
    "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "X-Upload-Content-Type": "video/mp4",
        "X-Upload-Content-Length": String(fileSize),
      },
      body: JSON.stringify({
        snippet: {
          title: meta.youtubeShorts.title,
          description: meta.youtubeShorts.description,
          tags: meta.youtubeShorts.tags,
          categoryId: "22",
        },
        status: { privacyStatus: "public", madeForKids: false },
      }),
    },
  );

  if (!initRes.ok) {
    throw new Error(
      `YouTube init failed: ${initRes.status} ${await initRes.text()}`,
    );
  }

  const uploadUrl = initRes.headers.get("Location");
  if (!uploadUrl) throw new Error("YouTube: no upload URL in init response");

  const fileBuffer = Bun.file(videoPath);
  const uploadRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": "video/mp4",
      "Content-Length": String(fileSize),
    },
    body: fileBuffer,
  });

  if (!uploadRes.ok) {
    throw new Error(
      `YouTube upload failed: ${uploadRes.status} ${await uploadRes.text()}`,
    );
  }

  const data = (await uploadRes.json()) as { id: string };
  return data.id;
}

// ── TikTok (Content Posting API v2) ─────────────────────────────────────────

async function uploadTikTok(
  videoPath: string,
  meta: PlatformMetadata,
): Promise<string> {
  const accessToken = process.env.TIKTOK_ACCESS_TOKEN!;
  const fileSize = statSync(videoPath).size;

  const initRes = await fetch(
    "https://open.tiktokapis.com/v2/post/publish/video/init/",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
      },
      body: JSON.stringify({
        post_info: {
          title: `${meta.tiktok.caption} ${meta.tiktok.hashtags.join(" ")}`,
          privacy_level: "PUBLIC_TO_EVERYONE",
          disable_duet: false,
          disable_comment: false,
        },
        source_info: {
          source: "FILE_UPLOAD",
          video_size: fileSize,
          chunk_size: fileSize,
          total_chunk_count: 1,
        },
      }),
    },
  );

  if (!initRes.ok) {
    throw new Error(
      `TikTok init failed: ${initRes.status} ${await initRes.text()}`,
    );
  }

  const { data } = (await initRes.json()) as {
    data: { upload_url: string; publish_id: string };
  };

  const fileBuffer = Bun.file(videoPath);
  const putRes = await fetch(data.upload_url, {
    method: "PUT",
    headers: {
      "Content-Range": `bytes 0-${fileSize - 1}/${fileSize}`,
      "Content-Type": "video/mp4",
    },
    body: fileBuffer,
  });

  if (!putRes.ok) {
    throw new Error(
      `TikTok file upload failed: ${putRes.status} ${await putRes.text()}`,
    );
  }

  return data.publish_id;
}

// ── Instagram Reels (Graph API v21) ─────────────────────────────────────────
// Requires PUBLIC_BASE_URL — the public HTTPS root of this server (e.g.
// https://clips.example.com). Clips are already served at /clips/preview/:id
// so no separate S3/R2 upload is needed if the server is internet-accessible.

async function uploadInstagramReel(
  clipId: number,
  meta: PlatformMetadata,
): Promise<string> {
  const accessToken = process.env.INSTAGRAM_ACCESS_TOKEN!;
  const igUserId = process.env.IG_USER_ID!;
  const publicVideoUrl = `${process.env.PUBLIC_BASE_URL}/clips/preview/${clipId}`;
  const caption = `${meta.instagram.caption}\n\n${meta.instagram.hashtags.join(" ")}`;

  const containerRes = await fetch(
    `https://graph.facebook.com/v21.0/${igUserId}/media`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        media_type: "REELS",
        video_url: publicVideoUrl,
        caption,
        access_token: accessToken,
      }),
    },
  );

  if (!containerRes.ok) {
    throw new Error(
      `Instagram container creation failed: ${containerRes.status} ${await containerRes.text()}`,
    );
  }

  const { id: creationId } = (await containerRes.json()) as { id: string };

  // Poll until Instagram finishes processing the video container
  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise((r) => setTimeout(r, 10_000));
    const statusRes = await fetch(
      `https://graph.facebook.com/v21.0/${creationId}?fields=status_code&access_token=${accessToken}`,
    );
    const { status_code } = (await statusRes.json()) as { status_code: string };
    if (status_code === "FINISHED") break;
    if (status_code === "ERROR")
      throw new Error("Instagram container processing failed");
  }

  const pubRes = await fetch(
    `https://graph.facebook.com/v21.0/${igUserId}/media_publish`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        creation_id: creationId,
        access_token: accessToken,
      }),
    },
  );

  if (!pubRes.ok) {
    throw new Error(
      `Instagram publish failed: ${pubRes.status} ${await pubRes.text()}`,
    );
  }

  const { id } = (await pubRes.json()) as { id: string };
  return id;
}

// ── Orchestrator ─────────────────────────────────────────────────────────────

export async function postClip(clipId: number, db: Db): Promise<void> {
  const clip = db.getClipById.get(clipId) as ClipRow | null;
  if (!clip?.output_path || !clip.metadata_json) {
    console.error(
      `[upload] Clip ${clipId} — missing output_path or metadata, skipping.`,
    );
    return;
  }

  const metadata = JSON.parse(clip.metadata_json) as PlatformMetadata;
  db.updateClipStatus.run("posting", clipId);

  const uploaders = [
    {
      platform: "youtube_shorts",
      enabled: !!(
        process.env.YOUTUBE_ACCESS_TOKEN ||
        (process.env.YOUTUBE_REFRESH_TOKEN &&
          process.env.YOUTUBE_CLIENT_ID &&
          process.env.YOUTUBE_CLIENT_SECRET)
      ),
      fn: () => uploadYouTubeShort(clip.output_path!, metadata),
    },
    {
      platform: "tiktok",
      enabled: !!process.env.TIKTOK_ACCESS_TOKEN,
      fn: () => uploadTikTok(clip.output_path!, metadata),
    },
    {
      platform: "instagram",
      enabled: !!(
        process.env.INSTAGRAM_ACCESS_TOKEN &&
        process.env.IG_USER_ID &&
        process.env.PUBLIC_BASE_URL
      ),
      fn: () => uploadInstagramReel(clipId, metadata),
    },
  ];

  const skipped = uploaders.filter((u) => !u.enabled);
  if (skipped.length > 0) {
    console.log(
      `[upload] Clip ${clipId} — skipping ${skipped.map((u) => u.platform).join(", ")} (credentials not configured)`,
    );
  }

  const active = uploaders.filter((u) => u.enabled);
  if (active.length === 0) {
    console.warn(
      `[upload] Clip ${clipId} — no platforms configured, leaving clip as approved.`,
    );
    db.updateClipStatus.run("approved", clipId);
    return;
  }

  const results = await Promise.allSettled(
    active.map((u) =>
      u.fn().then((postId) => ({ platform: u.platform, postId })),
    ),
  );

  let anySuccess = false;

  for (let i = 0; i < results.length; i++) {
    const result = results[i]!;
    const { platform } = active[i]!;

    if (result.status === "fulfilled") {
      db.insertUpload.run(clipId, platform, result.value.postId, "uploaded");
      console.log(
        `[upload] [OK] Clip ${clipId} -> ${platform} posted (id: ${result.value.postId})`,
      );
      anySuccess = true;
    } else {
      const errMsg =
        result.reason instanceof Error
          ? result.reason.message
          : String(result.reason);
      db.insertUploadError.run(clipId, platform, errMsg);
      console.error(
        `[upload] [FAILED] Clip ${clipId} -> ${platform}: ${errMsg}`,
      );
    }
  }

  if (anySuccess) {
    db.markClipPosted.run(clipId);
    console.log(`[upload] Clip ${clipId} marked as posted.`);
  } else {
    db.updateClipStatus.run("failed", clipId);
    console.error(
      `[upload] Clip ${clipId} — all platform uploads failed, marked as failed.`,
    );
  }
}
