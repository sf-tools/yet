import type { FileChange, ToolHistoryEntry } from '@/types';

type ToolCallLike = {
  toolCallId: string;
  toolName: string;
  input: unknown;
  providerExecuted?: boolean;
  title?: string;
  fileChanges?: FileChange[];
};

type ToolResultLike = ToolCallLike & {
  output: unknown;
};

type ToolErrorLike = ToolCallLike & {
  error: unknown;
};

export function createPendingToolEntry(part: ToolCallLike): ToolHistoryEntry {
  return {
    type: 'tool',
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    input: part.input,
    status: 'running',
    providerExecuted: part.providerExecuted,
    title: part.title,
    fileChanges: part.fileChanges,
  };
}

export function createCompletedToolEntry(part: ToolResultLike): ToolHistoryEntry {
  return {
    type: 'tool',
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    input: part.input,
    output: part.output,
    status: 'completed',
    providerExecuted: part.providerExecuted,
    title: part.title,
    fileChanges: part.fileChanges,
  };
}

export function createFailedToolEntry(part: ToolErrorLike): ToolHistoryEntry {
  return {
    type: 'tool',
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    input: part.input,
    status: 'failed',
    errorText: part.error instanceof Error ? part.error.message : String(part.error),
    providerExecuted: part.providerExecuted,
    title: part.title,
    fileChanges: part.fileChanges,
  };
}
