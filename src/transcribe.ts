import { runTranscriptionAgent } from "../agents/index.js";
import type { AgentStreamChunk } from "../agents/phases/types.js";
import { withRetry } from "../agents/utils/index.js";
import type { Word } from "./types.js";

export async function transcribeClipFromVideo(
  videoPath: string,
  startSec: number,
  endSec: number,
  tmpDir: string,
  slug: string,
  onChunk?: (chunk: AgentStreamChunk) => void,
): Promise<Word[]> {
  return withRetry(
    () =>
      runTranscriptionAgent(videoPath, startSec, endSec, tmpDir, slug, onChunk),
    2,
    "transcription",
  );
}
