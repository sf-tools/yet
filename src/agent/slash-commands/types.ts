import type { ThinkingMode } from '@/config';
import type { PermissionMode } from '@/permissions';
import type { AgentStore } from '@/store';
import type { ChoiceRequest, ChoiceSelection, HistoryEntry, StatusPanelState, TextPromptRequest, ThreadGoal } from '@/types';
import type { BackgroundTerminalSummary } from '@/agent/background-terminals';

export type SlashCommandArgs = {
  raw: string;
  invocation: string;
  argsText: string;
  argv: string[];
};

export type SlashCommandContext = {
  store: AgentStore;
  cleanup(code?: number): void;
  archiveCurrentSession(): Promise<void>;
  deleteCurrentSession(): Promise<void>;
  forkCurrentSession(name?: string): Promise<void>;
  startSideConversation(question?: string): Promise<void>;
  compactConversation(options?: { manual?: boolean; force?: boolean }): Promise<boolean>;
  setCurrentModel(model: string): void;
  setThinkingMode(thinkingMode: ThinkingMode): void;
  setFastModeEnabled(enabled: boolean): void;
  setPermissionMode(permissionMode: PermissionMode): void;
  setPlanningMode(enabled: boolean): void;
  enqueueSubmission(text: string, options?: { planningMode?: boolean }): void;
  openCommandArgumentPicker(commandName: string): void;
  openResumePicker(): Promise<void>;
  openConfigPicker(): Promise<void>;
  openStatusPanel(panel: StatusPanelState): Promise<void>;
  requestChoice(request: ChoiceRequest): Promise<ChoiceSelection | null>;
  requestTextInput(request: TextPromptRequest): Promise<string | null>;
  showFooterNotice(text: string, durationMs?: number): void;
  getActiveToolSummaries(): Array<{ names: string[]; description: string | null }>;
  getSessionId(): string;
  switchToSession(sessionId: string): Promise<void>;
  getLastRequestId(): string | null;
  getLastAssistantResponse(): string | null;
  getThreadTitle(): string | null;
  getSessionLineage(): { parentSessionId?: string; forkPoint?: number; side: boolean };
  setThreadTitle(title: string | null): void;
  copyToClipboard(text: string): Promise<void>;
  listBackgroundTerminals(): BackgroundTerminalSummary[];
  stopBackgroundTerminals(): number;
  printEntries(entries: HistoryEntry[]): void;
  persistEntries(entries: HistoryEntry[]): void;
  getGoal(): ThreadGoal | null;
  setGoal(goal: ThreadGoal | null): void;
};

export type TextStyle = (text: string) => string;

export type SlashCommandArgumentSuggestion =
  | string
  | {
      value: string;
      label?: string;
      suffix?: string;
      detail?: string;
      labelStyle?: TextStyle;
      suffixStyle?: TextStyle;
      detailStyle?: TextStyle;
    };

export type SlashCommandSuggestionContext = Pick<
  SlashCommandContext,
  'getSessionId'
> & {
  getCurrentModel(): string;
};

export type SlashCommand = {
  name: string;
  aliases?: string[];
  specialHiddenAliases?: string[];
  description: string;
  suggestedInput?: string;
  argumentSuggestions?:
    | readonly SlashCommandArgumentSuggestion[]
    | ((context: SlashCommandSuggestionContext) => readonly SlashCommandArgumentSuggestion[]);
  showArgumentSuggestionsOnExactInvocation?: boolean;
  showBusyIndicator?: boolean;
  isAvailable?(context: SlashCommandSuggestionContext): boolean;
  unavailableDetail?(context: SlashCommandSuggestionContext): string;
  execute(context: SlashCommandContext, args: SlashCommandArgs): Promise<void> | void;
};

export type SlashCommandInvocation = {
  command: SlashCommand;
  invocation: string;
  isAlias: boolean;
  hidden: boolean;
  specialHidden: boolean;
};

export type ResolvedSlashCommand = {
  command: SlashCommand;
  invocation: string;
  isAlias: boolean;
  argsText: string;
  argv: string[];
};

export type SlashCommandParseResult =
  | { type: 'empty' }
  | { type: 'unknown'; invocation: string }
  | ({ type: 'resolved' } & ResolvedSlashCommand);

export type SlashCommandSuggestion = {
  kind: 'slash-command';
  label: string;
  suffix?: string;
  detail: string;
  invocation: string;
  replacement: string;
  commandName: string;
  isAlias: boolean;
  disabled?: boolean;
  labelStyle?: TextStyle;
  suffixStyle?: TextStyle;
  detailStyle?: TextStyle;
};

export type SlashCommandQuery =
  | { type: 'invocation'; query: string }
  | { type: 'argument'; invocation: string; query: string };

export type SlashCommandRegistry = {
  commands: SlashCommand[];
  parse(input: string): SlashCommandParseResult | null;
  listSuggestions(query: SlashCommandQuery): SlashCommandSuggestion[];
};
