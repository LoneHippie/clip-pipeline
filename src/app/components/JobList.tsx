import type { JobRow } from '../App.js';

const ACTIVE_STATUSES = new Set(['uploading', 'queued', 'selecting_clips', 'processing']);

const STATUS_LABELS: Record<string, string> = {
  uploading:       'Uploading',
  queued:          'Queued',
  selecting_clips: 'Selecting clips',
  processing:      'Processing',
  pending_review:  'Pending review',
  approved:        'Approved',
  rejected:        'Rejected',
  posting:         'Posting',
  posted:          'Posted',
  failed:          'Failed',
};

function fmtTime(iso: string) {
  const d = new Date(iso + (iso.endsWith('Z') ? '' : 'Z'));
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

interface Props {
  jobs: JobRow[];
}

export function JobList({ jobs }: Props) {
  if (!jobs.length) return null;

  return (
    <div className="job-list">
      {jobs.map(job => {
        const isActive = ACTIVE_STATUSES.has(job.status);
        return (
          <div key={job.job_id} className="job-row">
            <span
              className={`badge ${job.status}`}
              title={job.status}
            >
              {isActive && <span className="spinner" />}
              {STATUS_LABELS[job.status] ?? job.status}
            </span>
            <span className="job-name" title={job.filename}>{job.filename}</span>
            <span className="job-time">{fmtTime(job.uploaded_at)}</span>
          </div>
        );
      })}
    </div>
  );
}
