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

export type HistoryEntry =
  | { type: 'entry'; kind: EntryKind; text: string }
  | { type: 'plain'; text: string }
  | { type: 'ansi'; text: string }
  | ForkedHistoryEntry
  | ResumeHintHistoryEntry
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
