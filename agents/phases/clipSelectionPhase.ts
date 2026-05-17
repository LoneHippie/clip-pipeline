import { google } from "@ai-sdk/google";
import { GoogleAIFileManager } from "@google/generative-ai/server";
import { generateObject } from "ai";
import path from "node:path";
import { z } from "zod";
import type { AnyClipSelection } from "../../src/types";
import { buildSystemPrompt } from "../context/loader";
import { loadSkillContent } from "../skills/index";
import { sleep } from "../utils/index";
import type { AgentStreamChunk } from "./types";

const SingleClipSchema = z.object({
  type: z.literal("single"),
  title: z.string().describe("Short punchy clip title, max 60 chars"),
  start: z.string().describe('Start time as MM:SS — e.g. "02:34"'),
  end: z.string().describe('End time as MM:SS — e.g. "03:18"'),
  hook: z
    .string()
    .describe(
      "Opening sentence/phrase that grabs attention in the first 3 seconds",
    ),
  viralityReason: z
    .string()
    .describe(
      "One sentence explaining why this clip works as a standalone short",
    ),
});

const CompositeClipSchema = z.object({
  type: z.literal("composite"),
  title: z
    .string()
    .describe("Short punchy title for the combined clip, max 60 chars"),
  segments: z
    .array(
      z.object({
        start: z.string().describe("Segment start as MM:SS"),
        end: z.string().describe("Segment end as MM:SS"),
      }),
    )
    .min(2)
    .max(3)
    .describe(
      "2–3 non-overlapping segments in chronological order, each 10–40 seconds. Only use when segments form a genuine setup-payoff or cause-effect arc.",
    ),
  hook: z
    .string()
    .describe("Opening sentence from the first segment that grabs attention"),
  viralityReason: z
    .string()
    .describe(
      "Why these segments together tell a stronger story than either alone",
    ),
});

const ClipSchema = z.object({
  clips: z
    .array(
      z.discriminatedUnion("type", [SingleClipSchema, CompositeClipSchema]),
    )
    .min(1)
    .max(8)
    .describe(
      "5–8 clips total. At most ONE may be composite — only include it if a genuine narrative payoff exists across segments.",
    ),
});

function parseMmSs(ts: string): number {
  const parts = ts.split(":");
  const m = parseInt(parts[0] ?? "0", 10);
  const s = parseFloat(parts[1] ?? "0");
  return m * 60 + s;
}

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".mkv": "video/x-matroska",
    ".avi": "video/x-msvideo",
    ".webm": "video/webm",
  };
  return map[ext] ?? "video/mp4";
}

export async function runClipSelectionPhase(
  videoPath: string,
  title: string,
  onChunk?: (chunk: AgentStreamChunk) => void,
): Promise<AnyClipSelection[]> {
  onChunk?.({
    type: "phase-start",
    phase: "clip-selection",
    text: "Starting clip selection...",
  });

  // Load context and skills — assemble the full system prompt
  const [context, viralCriteria] = await Promise.all([
    buildSystemPrompt({ agentName: "clip-selection" }),
    loadSkillContent("viralClipCriteria"),
  ]);

  const systemPrompt = [context.systemPrompt, "---", viralCriteria].join(
    "\n\n",
  );
  const mimeType = getMimeType(videoPath);

  const fileManager = new GoogleAIFileManager(
    process.env.GOOGLE_GENERATIVE_AI_API_KEY!,
  );

  // Upload video to Gemini File API
  onChunk?.({
    type: "tool-call",
    phase: "clip-selection",
    toolName: "uploadVideoToGemini",
    input: { videoPath },
  });
  const uploadResponse = await fileManager.uploadFile(videoPath, {
    mimeType,
    displayName: path.basename(videoPath),
  });
  onChunk?.({
    type: "tool-result",
    phase: "clip-selection",
    output: { fileName: uploadResponse.file.name },
  });

  // Poll until file reaches ACTIVE state
  let file = await fileManager.getFile(uploadResponse.file.name);
  while ((file.state as string) === "PROCESSING") {
    await sleep(5_000);
    file = await fileManager.getFile(uploadResponse.file.name);
  }
  if ((file.state as string) === "FAILED") {
    await fileManager.deleteFile(uploadResponse.file.name).catch(() => {});
    throw new Error(`Gemini file processing failed for: ${videoPath}`);
  }

  // Analyze video and select clips
  onChunk?.({
    type: "tool-call",
    phase: "clip-selection",
    toolName: "selectClipsViaGemini",
    input: { fileUri: file.uri },
  });

  const { object } = await generateObject({
    model: google("gemini-2.5-flash"),
    schema: ClipSchema,
    system: systemPrompt,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "file",
            data: new URL(file.uri),
            mediaType: mimeType,
          },
          {
            type: "text",
            text: `Analyze this video and identify the 3–8 best clips for social media (TikTok, Instagram Reels, YouTube Shorts).

Video title: ${title}

Rules for single clips (type: "single"):
- 20–90 seconds long
- Must be fully self-contained (no dangling context)
- Start on a strong hook: surprising claim, bold opinion, or emotional moment
- End at a natural pause or conclusion — never mid-sentence

Composite clip (type: "composite") — optional, at most one:
- Only if two or three moments in this specific video form a genuine setup-payoff arc together
- Each segment 10–40 seconds; total 25–90 seconds; segments in chronological order
- If no strong narrative connection exists, omit entirely

Return start/end as MM:SS only — do NOT return word-level timestamps`,
          },
        ],
      },
    ],
  });

  onChunk?.({
    type: "tool-result",
    phase: "clip-selection",
    output: { clipCount: object.clips.length },
  });

  // Clean up the Gemini-hosted file — it auto-expires in 48h but we delete proactively
  await fileManager.deleteFile(uploadResponse.file.name).catch(() => {
    console.warn(
      `[clipSelectionPhase] Failed to delete Gemini file: ${uploadResponse.file.name}`,
    );
  });

  // Parse timestamps and validate durations
  const clips: AnyClipSelection[] = object.clips.map((clip) => {
    if (clip.type === "composite") {
      const segments = clip.segments.map((seg) => {
        const startSec = parseMmSs(seg.start);
        const endSec = parseMmSs(seg.end);
        const dur = endSec - startSec;
        if (dur < 5 || dur > 45) {
          throw new Error(
            `Composite segment in "${clip.title}" has invalid duration: ${dur}s (expected 5–45s)`,
          );
        }
        return { startSec, endSec };
      });
      const totalDur = segments.reduce(
        (s, seg) => s + seg.endSec - seg.startSec,
        0,
      );
      if (totalDur < 20 || totalDur > 90) {
        throw new Error(
          `Composite clip "${clip.title}" total duration ${totalDur}s is out of range (20–90s)`,
        );
      }
      return {
        title: clip.title,
        segments,
        hook: clip.hook,
        viralityReason: clip.viralityReason,
      };
    }

    const startSec = parseMmSs(clip.start);
    const endSec = parseMmSs(clip.end);
    const duration = endSec - startSec;
    if (duration < 20 || duration > 120) {
      throw new Error(
        `Clip "${clip.title}" has invalid duration: ${duration}s (expected 20–120s)`,
      );
    }
    return {
      title: clip.title,
      startSec,
      endSec,
      hook: clip.hook,
      viralityReason: clip.viralityReason,
    };
  });

  onChunk?.({
    type: "phase-complete",
    phase: "clip-selection",
    text: `Selected ${clips.length} clips.`,
  });
  return clips;
}
