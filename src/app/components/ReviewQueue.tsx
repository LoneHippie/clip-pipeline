import { ClipCard } from './ClipCard.js';
import type { ClipRow } from '../App.js';

interface Props {
  clips: ClipRow[];
  onAction: (clipId: number) => void;
}

export function ReviewQueue({ clips, onAction }: Props) {
  if (!clips.length) {
    return (
      <div className="empty">
        No clips pending review. Upload a video to get started.
      </div>
    );
  }

  return (
    <div className="clip-grid">
      {clips.map(clip => (
        <ClipCard key={clip.id} clip={clip} onAction={onAction} />
      ))}
    </div>
  );
}
