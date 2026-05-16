import { useState } from 'react';
import type { ClipRow } from '../App.js';

interface Props {
  clip: ClipRow;
  onAction: (clipId: number) => void;
}

export function ClipCard({ clip, onAction }: Props) {
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);

  const act = async (action: 'approve' | 'reject') => {
    setBusy(action);
    try {
      await fetch(`/api/review/${clip.id}/${action}`, { method: 'POST' });
      onAction(clip.id);
    } catch (err) {
      console.error(`Failed to ${action} clip ${clip.id}:`, err);
      setBusy(null);
    }
  };

  const duration = (clip.end_sec - clip.start_sec).toFixed(0);

  return (
    <div className="clip-card">
      <div className="clip-video-wrapper">
        <video
          className="clip-video"
          src={`/clips/preview/${clip.id}`}
          controls
          playsInline
          preload="metadata"
        />
      </div>

      <div className="clip-body">
        <div>
          <div className="clip-title">{clip.title}</div>
          <div className="clip-virality" style={{ marginTop: 4 }}>
            {clip.error
              ? <span style={{ color: 'var(--red)' }}>Error: {clip.error}</span>
              : `${duration}s clip`}
          </div>
        </div>

        {clip.metadata && (
          <div className="clip-metadata">
            <details>
              <summary>Platform metadata</summary>
              <pre>{JSON.stringify(clip.metadata, null, 2)}</pre>
            </details>
          </div>
        )}

        <div className="clip-actions">
          <button
            className="btn btn-approve"
            disabled={busy !== null}
            onClick={() => void act('approve')}
          >
            {busy === 'approve' ? <span className="spinner" /> : null}
            {' '}Approve
          </button>
          <button
            className="btn btn-reject"
            disabled={busy !== null}
            onClick={() => void act('reject')}
          >
            {busy === 'reject' ? <span className="spinner" /> : null}
            {' '}Reject
          </button>
        </div>
      </div>
    </div>
  );
}
