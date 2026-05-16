/**
 * Public agent entry points.
 *
 * Each agent wraps a specialized AI step in the pipeline and follows the
 * phase / skills / context architecture described in AGENTS_ARCHITECTURE.md.
 *
 *  - runClipSelectionAgent  → Gemini 2.5 Flash (video understanding + generateObject)
 *  - runTranscriptionAgent  → Groq Whisper (ffmpeg audio extraction + word timestamps)
 *  - runMetadataAgent       → Claude Haiku (platform-native copy via generateObject)
 */

export { runClipSelectionPhase as runClipSelectionAgent } from "./phases/clipSelectionPhase.js";
export { runMetadataPhase as runMetadataAgent } from "./phases/metadataPhase.js";
export { runTranscriptionPhase as runTranscriptionAgent } from "./phases/transcriptionPhase.js";
export type { AgentStreamChunk } from "./phases/types.js";
