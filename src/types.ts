export const SOURCES = ["chatgpt", "gemini", "claude"] as const;
export type Source = typeof SOURCES[number];

export interface Message {
  role: 'user' | 'assistant' | 'system';
  text: string;
  ts?: string;
  removed: boolean;
  remove_reason?: string;
}

export interface Conversation {
  id: string;
  title: string;
  created?: string;
  model?: string;
  messages: Message[];
}

export interface SourceData {
  source: string;
  year?: number;
  conversations: Conversation[];
}

export interface CommandOptions {
  root: string;
  verbose: boolean;
}

export interface IngestOptions extends CommandOptions {
  inputs: string[];
}

export interface CleanOptions extends CommandOptions {
  source?: string;
}

export interface ExportOptions extends CommandOptions {
  source?: string;
}