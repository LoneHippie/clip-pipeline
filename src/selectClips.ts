import { runClipSelectionAgent } from "../agents/index.js";
import type { AgentStreamChunk } from "../agents/phases/types.js";
import { withRetry } from "../agents/utils/index.js";
import type { AnyClipSelection } from "./types.js";

export async function selectClips(
  localVideoPath: string,
  videoTitle: string,
  onChunk?: (chunk: AgentStreamChunk) => void,
): Promise<AnyClipSelection[]> {
  return withRetry(
    () => runClipSelectionAgent(localVideoPath, videoTitle, onChunk),
    2,
    "clip-selection",
  );
}
