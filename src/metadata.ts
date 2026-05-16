import { runMetadataAgent } from "../agents/index.js";
import type { AgentStreamChunk } from "../agents/phases/types.js";
import type { PlatformMetadata } from "./types.js";

export async function generateMetadata(
  clipTranscript: string,
  clipTitle: string,
  viralityReason: string,
  onChunk?: (chunk: AgentStreamChunk) => void,
): Promise<PlatformMetadata> {
  return runMetadataAgent(clipTranscript, clipTitle, viralityReason, onChunk);
}
