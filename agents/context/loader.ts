import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { getAgentConfig } from './registry.js';
import type { ContextInput, LoadedContext } from './types.js';

const CONTEXT_FILES_DIR = path.join(import.meta.dir, '../context_files');

export async function buildSystemPrompt(input: ContextInput): Promise<LoadedContext> {
  const config = getAgentConfig(input.agentName);
  const loadedFiles: string[] = [];
  const errors: string[] = [];
  const sections: string[] = [config.baseSystemPrompt];

  if (config.contextFiles.length > 0) {
    sections.push('# Pipeline Context');

    for (const fileName of config.contextFiles) {
      const filePath = path.join(CONTEXT_FILES_DIR, fileName);
      if (!existsSync(filePath)) {
        errors.push(`Context file not found: ${fileName}`);
        continue;
      }
      const content = readFileSync(filePath, 'utf8').trim();
      if (!content) {
        errors.push(`Context file is empty: ${fileName}`);
        continue;
      }
      sections.push(`## ${fileName.replace('.md', '')}\n\n${content}`);
      loadedFiles.push(fileName);
    }
  }

  return {
    systemPrompt: sections.join('\n\n'),
    loadedFiles,
    errors,
  };
}
