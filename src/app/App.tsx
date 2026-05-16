import { useState, useEffect, useCallback } from "react";
import { UploadSection } from "./components/UploadSection.js";
import { JobList } from "./components/JobList";
import { ReviewQueue } from "./components/ReviewQueue";

export interface JobRow {
  job_id: string;
  filename: string;
  source_path: string;
  status: string;
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
  metadata: PlatformMetadata | null;
  status: string;
  error: string | null;
  created_at: string;
}

export interface PlatformMetadata {
  tiktok: { caption: string; hashtags: string[] };
  instagram: { caption: string; hashtags: string[] };
  youtubeShorts: { title: string; description: string; tags: string[] };
}

export default function App() {
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [reviewClips, setReview] = useState<ClipRow[]>([]);

  const fetchJobs = useCallback(async () => {
    const r = await fetch("/api/jobs").catch(() => null);
    if (r?.ok) setJobs((await r.json()) as JobRow[]);
  }, []);

  const fetchReview = useCallback(async () => {
    const r = await fetch("/api/review").catch(() => null);
    if (r?.ok) setReview((await r.json()) as ClipRow[]);
  }, []);

  // Initial fetch
  useEffect(() => {
    void fetchJobs();
    void fetchReview();
  }, [fetchJobs, fetchReview]);

  // Poll jobs every 3 s, review clips every 5 s
  useEffect(() => {
    const j = setInterval(fetchJobs, 3_000);
    const r = setInterval(fetchReview, 5_000);
    return () => {
      clearInterval(j);
      clearInterval(r);
    };
  }, [fetchJobs, fetchReview]);

  const handleUploaded = () => {
    void fetchJobs();
  };

  const handleReviewAction = (clipId: number) => {
    setReview((prev) => prev.filter((c) => c.id !== clipId));
    void fetchJobs();
  };

  return (
    <div className="layout">
      <div className="header">
        <h1>Clip Pipeline</h1>
        <span className="subtitle">Short-form video automation</span>
      </div>

      <div className="section">
        <div className="section-title">Upload</div>
        <UploadSection onUploaded={handleUploaded} />
      </div>

      {jobs.length > 0 && (
        <div className="section">
          <div className="section-title">Jobs</div>
          <JobList jobs={jobs} />
        </div>
      )}

      <div className="section">
        <div className="section-title">
          Review Queue
          {reviewClips.length > 0 && (
            <span
              style={{ marginLeft: 8, color: "var(--blue)", fontWeight: 700 }}
            >
              {reviewClips.length}
            </span>
          )}
        </div>
        <ReviewQueue clips={reviewClips} onAction={handleReviewAction} />
      </div>
    </div>
  );
}
