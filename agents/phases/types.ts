export type PhaseName = 'clip-selection' | 'transcription' | 'metadata';

export type AgentStreamChunk =
  | { type: 'phase-start';    phase: PhaseName; text: string }
  | { type: 'phase-complete'; phase: PhaseName; text: string }
  | { type: 'tool-call';      phase: PhaseName; toolName: string; input: unknown }
  | { type: 'tool-result';    phase: PhaseName; output: unknown }
  | { type: 'text-delta';     phase: PhaseName; text: string }
  | { type: 'error';          message: string }
  | { type: 'finish' };
