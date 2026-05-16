export type AgentName = "clip-selection" | "transcription" | "metadata";

export interface AgentContextConfig {
  baseSystemPrompt: string;
  contextFiles: string[];
}

export interface LoadedContext {
  systemPrompt: string;
  loadedFiles: string[];
  errors: string[];
}

export interface ContextInput {
  agentName: AgentName;
}
