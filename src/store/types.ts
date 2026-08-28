import type { AgentMessage } from '@/agent/messages';
import type { ThinkingMode } from '@/config';
import type { PermissionMode } from '@/permissions';
import type { ApprovalRequest, ChoiceRequest, FileChange, HistoryEntry } from '@/types';

export type ComposerPasteRange = {
  start: number;
  end: number;
};

export type QueuedSubmission = {
  text: string;
  planningMode?: boolean;
};

export type AgentState = {
  messages: AgentMessage[];
  inputChars: string[];
  pasteRanges: ComposerPasteRange[];
  historyEntries: HistoryEntry[];
  queuedSubmissions: QueuedSubmission[];
  pendingSteers: QueuedSubmission[];
  cursor: number;
  busy: boolean;
  busyStatusText: string | null;
  closed: boolean;
  liveAssistantText: string;
  liveReasoningText: string;
  selectedSuggestion: number;
  currentModel: string;
  thinkingMode: ThinkingMode;
  fastModeEnabled: boolean;
  lastPromptTokens: number;
  lastOutputTokens: number;
  lastReasoningTokens: number;
  livePromptTokens: number;
  liveOutputTokens: number;
  liveReasoningTokens: number;
  totalCost: number;
  abortController: AbortController | null;
  abortRequested: boolean;
  steerRequested: boolean;
  pendingApproval: ApprovalRequest | null;
  pendingChoice: ChoiceRequest | null;
  pendingChoiceIndex: number;
  footerNotice: string | null;
  sessionFileChanges: FileChange[];
  permissionMode: PermissionMode;
  autoCompactEnabled: boolean;
  planningMode: boolean;
  showThinking: boolean;
  compacting: boolean;
};
