import { anthropic } from "@ai-sdk/anthropic";
import { generateObject } from "ai";
import { z } from "zod";
import type { PlatformMetadata } from "../../src/types.js";
import { buildSystemPrompt } from "../context/loader.js";
import { loadSkillContent } from "../skills/index.js";
import type { AgentStreamChunk } from "./types.js";

const MetadataSchema = z.object({
  tiktok: z.object({
    caption: z
      .string()
      .describe("Hook first line. Max 150 chars. No hashtags in body."),
    hashtags: z
      .array(z.string())
      .describe("3–5 hashtags, each prefixed with #"),
  }),
  instagram: z.object({
    caption: z
      .string()
      .describe("2–3 sentences. Max 300 chars. End with a question."),
    hashtags: z
      .array(z.string())
      .describe("10–15 hashtags, each prefixed with #"),
  }),
  youtubeShorts: z.object({
    title: z.string().describe("SEO title, max 60 chars, front-load keyword"),
    description: z
      .string()
      .describe("2–3 sentences with keywords + full video CTA. Max 200 chars."),
    tags: z.array(z.string()).describe("8–10 metadata tags without # prefix"),
  }),
});

export async function runMetadataPhase(
  transcript: string,
  title: string,
  viralityReason: string,
  onChunk?: (chunk: AgentStreamChunk) => void,
): Promise<PlatformMetadata> {
  onChunk?.({
    type: "phase-start",
    phase: "metadata",
    text: "Generating platform metadata...",
  });

  const [context, guidelines] = await Promise.all([
    buildSystemPrompt({ agentName: "metadata" }),
    loadSkillContent("platformGuidelines"),
  ]);

  const systemPrompt = [context.systemPrompt, "---", guidelines].join("\n\n");

  onChunk?.({
    type: "tool-call",
    phase: "metadata",
    toolName: "generatePlatformMetadata",
    input: { title },
  });

  const { object } = await generateObject({
    model: anthropic("claude-haiku-4-5"),
    schema: MetadataSchema,
    system: systemPrompt,
    prompt: `Generate platform-specific social media metadata for this clip.

Clip title hint: ${title}
Why this clip works: ${viralityReason}
Transcript: ${transcript}

Write copy that feels native to each platform. TikTok: punchy and direct. Instagram: conversational with a CTA question. YouTube Shorts: SEO-focused title.`,
  });

  onChunk?.({
    type: "tool-result",
    phase: "metadata",
    output: { platforms: ["tiktok", "instagram", "youtubeShorts"] },
  });
  onChunk?.({
    type: "phase-complete",
    phase: "metadata",
    text: "Platform metadata generated.",
  });

  return object as PlatformMetadata;
}
