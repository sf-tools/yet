export enum EntryKind {
  User = 'user',
  Assistant = 'assistant',
  Reasoning = 'reasoning',
  Tool = 'tool',
  Shell = 'shell',
  Error = 'error',
  Meta = 'meta',
}

export type DiffStat = {
  added: number;
  modified: number;
  removed: number;
};

export type FileChange = {
  path: string;
  diff: string;
  stats: DiffStat;
  changeKind: 'created' | 'modified' | 'deleted';
  hasChanges: boolean;
};

export type ToolHistoryEntry = {
  type: 'tool';
  toolCallId: string;
  toolName: string;
  input: unknown;
  output?: unknown;
  status: 'running' | 'completed' | 'failed';
  errorText?: string;
  providerExecuted?: boolean;
  title?: string;
  fileChanges?: FileChange[];
};

export type CompactedHistoryEntry = {
  type: 'compacted';
  summary: string;
  previousMessageCount: number;
  nextMessageCount: number;
  automatic: boolean;
};

export type ForkedHistoryEntry = {
  type: 'forked';
  parentSessionId: string;
  parentTitle?: string;
};

export type ResumeHintHistoryEntry = {
  type: 'resume_hint';
  command: string;
};

export type BackgroundProcessesHistoryEntry = {
  type: 'background_processes';
  processes: Array<{
    sessionId: number;
    command: string;
    recentChunks: string[];
  }>;
};

export type CollaborationHistoryEntry = {
  type: 'collaboration';
  activityId: string;
  action: 'spawned' | 'interacted' | 'waiting' | 'interrupted' | 'completed';
  actorPath: string;
  targetPath?: string;
  message?: string;
};

export type StatusPanelState = {
  title: string;
  sections: Array<{
    title: string;
    rows: Array<{ label: string; value: string }>;
  }>;
};

export type SubagentsPickerState = {
  selectedIndex: number;
  items: Array<{
    id: string;
    path: string;
    label: string;
    status: string;
    current: boolean;
    closed: boolean;
  }>;
};

export type AgentsOverviewState = {
  query: string;
  draft: string;
  mode: 'browse' | 'search' | 'dispatch' | 'rename';
  grouping: 'project' | 'status';
  selectedIndex: number;
  roots: Array<{
    rootId: string;
    title: string | null;
    cwd: string;
    agents: Array<{
      id: string;
      path: string;
      label: string;
      status: string;
      model: string;
      thinkingMode: string;
    }>;
  }>;
};

export type GoalStatus =
  | 'active'
  | 'paused'
  | 'blocked'
  | 'usage_limited'
  | 'budget_limited'
  | 'complete';

export type ThreadGoal = {
  objective: string;
  status: GoalStatus;
  tokenBudget?: number;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
};

export type TurnBoundary = {
  messageIndex: number;
  prompt: string;
  goal?: ThreadGoal | null;
};

export type HistoryEntry =
  | { type: 'entry'; kind: EntryKind; text: string; turn?: TurnBoundary }
  | { type: 'plain'; text: string }
  | { type: 'ansi'; text: string }
  | { type: 'separator'; elapsedSeconds: number }
  | { type: 'goal_summary'; goal: ThreadGoal }
  | ForkedHistoryEntry
  | ResumeHintHistoryEntry
  | BackgroundProcessesHistoryEntry
  | CollaborationHistoryEntry
  | CompactedHistoryEntry
  | ToolHistoryEntry;

export type LogUpdate = ((...text: string[]) => void) & {
  clear(): void;
  done(): void;
  persist(...text: string[]): void;
};

export type ShellResult = {
  exitCode: number;
  output: string;
};

export type ApprovalScope = 'command' | 'edit';

export type ApprovalRequest = {
  scope: ApprovalScope;
  title: string;
  detail: string;
  body?: string[];
  fileChanges?: FileChange[];
};

export type ApprovalDecision = 'allow-once' | 'deny';

export type ChoiceOption = {
  value: string;
  label: string;
  detail?: string;
};

export type ChoiceRequest = {
  title: string;
  detail: string;
  options: ChoiceOption[];
  recommendedValue?: string;
};

export type ChoiceSelection = ChoiceOption & {
  index: number;
};

export type TextPromptRequest = {
  title: string;
  detail: string;
  initialValue: string;
  placeholder?: string;
  secret?: boolean;
};

export type ConfigPickerItem = {
  id: string;
  label: string;
  detail: string;
  enabled: boolean;
};

export type ConfigPickerState = {
  title: string;
  detail: string;
  items: ConfigPickerItem[];
  selectedIndex: number;
};

export type Rgb = {
  r: number;
  g: number;
  b: number;
};

export type Keypress = {
  ctrl?: boolean;
  meta?: boolean;
  name?: string;
};
