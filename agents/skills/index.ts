import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const SKILLS_DIR = path.join(import.meta.dir);

export type SkillName =
  | "viralClipCriteria"
  | "platformGuidelines"
  | "transcriptionConfig";

const SKILL_DESCRIPTIONS: Record<SkillName, string> = {
  viralClipCriteria:
    "Criteria for what makes a short-form clip go viral — hooks, patterns, red flags",
  platformGuidelines:
    "Platform-native copywriting rules for TikTok, Instagram Reels, and YouTube Shorts",
  transcriptionConfig:
    "Groq Whisper settings and ffmpeg audio extraction parameters",
};

/**
 * Load the markdown content of a named skill.
 * Returns the content string, or an empty string if the file is missing.
 */
export async function loadSkillContent(name: SkillName): Promise<string> {
  const filePath = path.join(SKILLS_DIR, `${name}.md`);
  if (!existsSync(filePath)) {
    console.warn(`[skills] Skill "${name}" not found at ${filePath}`);
    return "";
  }
  return readFileSync(filePath, "utf8").trim();
}

export { SKILL_DESCRIPTIONS };
