import type { AgentMessage, AgentUsage } from '@/agent/messages';
import type { ThinkingMode } from '@/config';
import type { PermissionMode } from '@/permissions';
import type {
  ApprovalRequest,
  AgentsOverviewState,
  ChoiceRequest,
  ConfigPickerState,
  FileChange,
  HistoryEntry,
  StatusPanelState,
  SubagentsPickerState,
  TextPromptRequest,
  ThreadGoal,
} from '@/types';

export type ComposerPasteRange = {
  start: number;
  end: number;
};

export type QueuedSubmission = {
  text: string;
  planningMode?: boolean;
  hidden?: boolean;
  goalContinuation?: boolean;
  loopGeneration?: number;
};

export type SideConversationState = {
  parentSessionId: string;
  parentTitle?: string;
  active: boolean;
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
  backgroundWaitCommand: string | null;
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
  sessionUsage: AgentUsage;
  totalCost: number;
  abortController: AbortController | null;
  abortRequested: boolean;
  steerRequested: boolean;
  pendingApproval: ApprovalRequest | null;
  pendingChoice: ChoiceRequest | null;
  pendingChoiceIndex: number;
  pendingTextPrompt: TextPromptRequest | null;
  configPicker: ConfigPickerState | null;
  statusPanel: StatusPanelState | null;
  subagentsPicker: SubagentsPickerState | null;
  agentsOverview: AgentsOverviewState | null;
  footerNotice: string | null;
  sessionFileChanges: FileChange[];
  permissionMode: PermissionMode;
  autoCompactEnabled: boolean;
  planningMode: boolean;
  showThinking: boolean;
  showCommandSummaries: boolean;
  compacting: boolean;
  sideConversation: SideConversationState | null;
  goal: ThreadGoal | null;
};
