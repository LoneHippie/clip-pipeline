export type JobStatus =
  | "uploading"
  | "queued"
  | "selecting_clips"
  | "processing"
  | "pending_review"
  | "approved"
  | "rejected"
  | "posting"
  | "posted"
  | "failed";

export interface VideoJob {
  jobId: string;
  originalFilename: string;
  localPath: string;
  uploadedAt: string;
  status: JobStatus;
}

export interface ClipSelection {
  title: string;
  startSec: number;
  endSec: number;
  hook: string;
  viralityReason: string;
}

export interface Word {
  word: string;
  start: number;
  end: number;
}

export interface ProcessedClip {
  clipId: number;
  selection: ClipSelection;
  words: Word[];
  outputPath: string;
  previewUrl: string;
  metadata?: PlatformMetadata;
}

export interface PlatformMetadata {
  tiktok: {
    caption: string;
    hashtags: string[];
  };
  instagram: {
    caption: string;
    hashtags: string[];
  };
  youtubeShorts: {
    title: string;
    description: string;
    tags: string[];
  };
}

// DB row shapes returned by SQLite queries
export interface JobRow {
  job_id: string;
  filename: string;
  source_path: string;
  status: JobStatus;
  uploaded_at: string;
  updated_at: string;
}

export interface ClipRow {
  id: number;
  job_id: string;
  title: string;
  start_sec: number;
  end_sec: number;
  output_path: string | null;
  metadata_json: string | null;
  status: string;
  error: string | null;
  created_at: string;
  posted_at: string | null;
  cleaned_at: string | null;
  source_path?: string;
}
