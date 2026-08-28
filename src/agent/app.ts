import { createTheme } from '@/theme';
import { createToolRegistry } from '@/tools';
import { runUserShell } from './shell';
import { BackgroundTerminalManager } from './background-terminals';
import { randomUUID } from 'node:crypto';
import { relative, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { resolveInputBinding, splitInputEvents } from './keybinds';
import { takeOverEarlyStdin } from './early-stdin';
import { startMentionIndex } from './mention-index';
import { discoverSkills, loadSkillInstructionMessages, renderSkillsCatalog, selectedSkills, type SkillMetadata } from './skills';
import { PromptHistoryStore } from './prompt-history';
import { blankLine, vstack } from '@/render/primitives';
import { renderFooter } from '@/render/components/footer';
import { renderStatusIndicator } from '@/render/components/status-indicator';
import type { ReadStream as TtyReadStream } from 'node:tty';
import { renderHistoryEntry } from '@/render/components/entry';
import {
  commandActivityIsRunning,
  isCommandToolEntry,
  renderCommandActivity,
} from '@/render/components/tools/command-activity';
import { compactMessages, canCompactMessages } from './compact';
import { renderSuggestions } from '@/render/components/suggestions';
import { renderChoicePrompt, renderOutputPreview } from '@/render/components/transcript';
import { renderConfigPicker } from '@/render/components/config-picker';
import {
  renderTranscriptContent,
  renderTranscriptViewport,
} from '@/render/components/transcript-overlay';
import { renderPendingInput } from '@/render/components/pending-input';
import { IMAGE_MEDIA_TYPES, parseDroppedImagePaths } from './path-detect';
import { copyTextToClipboard } from './clipboard-text';
import { readClipboardImage } from './clipboard-image';
import { createFileChange, readOptionalFile } from '@/file-changes';
import {
  builtinSlashCommands,
  createSlashCommandRegistry,
  type ResolvedSlashCommand,
  type SlashCommandContext,
} from './slash-commands';
import {
  createTurnContextEvent,
  hydrateStateFromSession,
  loadYetSession,
  persistedStateFromAgentState,
  SessionRecorder,
  type ThreadNameSource,
  type YetSessionEvent,
} from './session-storage';
import {
  cloneInactiveAgentState,
  createSideConversationState,
  SIDE_DEVELOPER_INSTRUCTIONS,
} from './side-conversation';
import { applyConfigPickerState, createConfigPickerState } from './config-settings';
import { createProvisionalThreadTitle, startBackgroundThreadTitle, type BackgroundThreadTitleRequest } from './thread-title';
import { normalizePtyOutput, plain, installSegmentContainingPolyfill } from '@/text';
import { handleAbortKeypress, createAbortController, resetAbortState } from './abort';
import { renderComposer, moveComposerCursorVertical } from '@/render/components/composer';
import { acceptComposerSuggestion, listComposerSuggestions } from './composer-suggestions';
import { createAgentStore, type AgentState, type AgentStore, type QueuedSubmission } from '@/store';

import { attachFromBytes, attachFromPath, extractTokens, findAttachment, IMAGE_TOKEN_PATTERN, type Attachment } from './image-attachments';
import { displayImageTokens } from './image-tokens';

import { createRenderContext, frameWidth, renderExitSummary, renderHeader, serializeBlock } from '@/render';

import { getLastAssistantResponse, type AgentImagePart, type AgentMessage, type AgentTextPart } from './messages';
import { runAgentLoop } from './runner';
import { BlockStreamPump } from './block-stream';
import {
  isPotentiallyUnsafeCommand,
  resolvePermissionProfile,
  shouldPromptForTool,
  type PermissionMode,
  type ToolPermission,
} from '@/permissions';

import { createFailedToolEntry, createPendingToolEntry, createCompletedToolEntry } from './tool-history';

import { cycleThinkingMode, getCompactionTriggerTokens, getSupportedThinkingModes, loadYetPreferences, saveYetPreferences } from '@/config';

import {
  EntryKind,
  type ApprovalDecision,
  type ApprovalRequest,
  type ChoiceRequest,
  type ChoiceSelection,
  type FileChange,
  type HistoryEntry,
  type ToolHistoryEntry,
} from '@/types';

const RAINBOW_PHRASE_PATTERN = /you'?re absolutely right/i;
const BRACKETED_PASTE_START = '\u001b[200~';
const BRACKETED_PASTE_END = '\u001b[201~';
const TRANSCRIPT_SCREEN_ENTER = '\u001b[?1049h\u001b[?1007h';
const TRANSCRIPT_SCREEN_LEAVE = '\u001b[?1007l\u001b[?1049l';

function bracketedPasteSuffixLength(text: string) {
  const maxLength = Math.min(text.length, BRACKETED_PASTE_START.length - 1);

  for (let length = maxLength; length > 1; length -= 1) {
    if (BRACKETED_PASTE_START.startsWith(text.slice(-length))) return length;
  }

  return 0;
}

function sameLines(left: string[], right: string[]) {
  return left.length === right.length && left.every((line, index) => line === right[index]);
}

function isCommandHistoryEntry(entry: HistoryEntry) {
  return entry.type === 'tool' && isCommandToolEntry(entry);
}

function commandActivityEnd(entries: HistoryEntry[], start: number) {
  let end = start;
  while (end < entries.length && isCommandHistoryEntry(entries[end])) end += 1;
  return end;
}

function estimateTokenCount(text: string) {
  return Math.max(0, Math.ceil(Array.from(text).length / 4));
}

function estimateValueTokens(value: unknown): number {
  if (typeof value === 'string') return estimateTokenCount(value);
  if (Array.isArray(value)) return value.reduce((sum, part) => sum + estimateValueTokens(part), 0);
  if (value == null) return 0;

  try {
    return estimateTokenCount(JSON.stringify(value));
  } catch {
    return estimateTokenCount(String(value));
  }
}

function estimateMessageTokens(messages: AgentMessage[]) {
  return messages.reduce((sum, message) => sum + estimateValueTokens('content' in message ? message.content : message), 0);
}

export type AgentAppOptions = {
  initialState?: AgentState;
  initialPrompt?: string;
  sessionId?: string;
  threadTitle?: string;
  rolloutPath?: string;
  sessionCreatedAt?: string;
  model?: string;
  thinkingMode?: AgentState['thinkingMode'];
  permissionMode?: PermissionMode;
  parentSessionId?: string;
  forkPoint?: number;
};

type SideConversationRuntime = {
  active: boolean;
  parentSessionId: string;
  parentState: AgentState;
  parentTitle: string | null;
  parentLastRequestId: string | null;
  parentRolloutPath?: string;
  parentCreatedAt?: string;
  parentLineageId?: string;
  parentForkPoint?: number;
  parentFileBaselines: Map<string, string | null>;
  sideSessionId: string;
  sideState: AgentState;
  sideLastRequestId: string | null;
  sideFileBaselines: Map<string, string | null>;
  closeRequested: boolean;
};

export class AgentApp {
  private readonly store: AgentStore;
  private readonly theme = createTheme();

  private transientLineCount = 0;
  private committedHistoryCount = 0;
  private headerPrinted = false;
  private lastTransientLines: string[] = [];
  private lastRenderColumns = 0;
  private lastRenderRows = 0;
  private transcriptOpen = false;
  private transcriptScrollOffset = 0;
  private transcriptContentCache: {
    historyRevision: number;
    width: number;
    reasoning: string;
    assistant: string;
    content: ReturnType<typeof renderTranscriptContent>;
  } | null = null;
  private backgroundWaitToolCallId: string | null = null;
  private readonly sessionFileBaselines = new Map<string, string | null>();
  private readonly backgroundTerminals = new BackgroundTerminalManager(() => this.scheduleRender());

  private readonly tools = createToolRegistry({
    workspaceRoot: process.cwd(),
    execCommand: (command, options) => this.backgroundTerminals.exec(command, options),
    writeStdin: (sessionId, chars, options) =>
      this.backgroundTerminals.write(sessionId, chars, options),
    authorize: (request, authorization) => this.authorizeTool(request, authorization),
    getPermissionMode: () => this.state.permissionMode,
    getPlanningMode: () => this.state.planningMode,
    getThinkingMode: () => this.state.thinkingMode,
    recordFileMutations: files => {
      if (!files.some(file => file.previousContent !== file.nextContent)) return;
      for (const file of files) {
        if (!this.sessionFileBaselines.has(file.path)) this.sessionFileBaselines.set(file.path, file.previousContent);
      }
    },
  });
  private readonly slashCommands = createSlashCommandRegistry(builtinSlashCommands, {
    getSessionId: () => this.sessionId,
    getCurrentModel: () => this.state.currentModel,
  });

  private readonly statusAnimationTimer: ReturnType<typeof setInterval>;
  private readonly rainbowTimer: ReturnType<typeof setInterval>;
  private busyStartedAt: number | null = null;
  private sessionId: string;
  private readonly promptHistory = new PromptHistoryStore();
  private readonly bootFromSnapshot: boolean;
  private readonly modelOverride?: string;
  private readonly thinkingModeOverride?: AgentState['thinkingMode'];
  private readonly permissionModeOverride?: PermissionMode;
  private readonly initialPrompt?: string;
  private lastRequestId: string | null = null;
  private threadTitle: string | null;
  private threadTitleRequest: BackgroundThreadTitleRequest | null = null;
  private sessionRecorder: SessionRecorder | null = null;
  private sessionRolloutPath?: string;
  private sessionCreatedAt?: string;
  private sessionParentId?: string;
  private sessionForkPoint?: number;
  private sideConversation: SideConversationRuntime | null = null;
  private drainingQueuedSubmissions = false;
  private activeSubmissionTask: Promise<void> | null = null;
  private renderTimer: ReturnType<typeof setTimeout> | null = null;
  private footerNoticeTimer: ReturnType<typeof setTimeout> | null = null;
  private renderScheduled = false;
  private lastRenderAt = 0;
  private historyNavigationIndex: number | null = null;
  private historyNavigationDraft = '';
  private preferredComposerColumn: number | null = null;
  private pendingApprovalResolver: ((decision: ApprovalDecision) => void) | null = null;
  private pendingChoiceResolver: ((selection: ChoiceSelection | null) => void) | null = null;
  private configPickerResolver: (() => void) | null = null;
  private stdin: TtyReadStream = process.stdin;
  private bracketedPasteActive = false;
  private bracketedPasteBuffer = '';
  private stdinBuffer = '';
  private stdinTask: Promise<void> = Promise.resolve();
  private skills: SkillMetadata[] = [];

  private clearTransientBlock() {
    if (this.transientLineCount <= 0) {
      this.lastTransientLines = [];
      return;
    }

    if (!process.stdout.isTTY) {
      this.transientLineCount = 0;
      this.lastTransientLines = [];
      return;
    }

    if (this.transientLineCount > 1) process.stdout.write(`\u001b[${this.transientLineCount - 1}F`);
    else process.stdout.write('\r');

    for (let index = 0; index < this.transientLineCount; index += 1) {
      process.stdout.write('\u001b[2K\r');
      if (index < this.transientLineCount - 1) process.stdout.write('\u001b[E');
    }

    if (this.transientLineCount > 1) process.stdout.write(`\u001b[${this.transientLineCount - 1}F`);
    this.transientLineCount = 0;
    this.lastTransientLines = [];
  }

  private redrawTransientLines(lines: string[]) {
    this.clearTransientBlock();
    if (lines.length === 0) return;

    process.stdout.write(lines.join('\n'));
    this.transientLineCount = lines.length;
    this.lastTransientLines = [...lines];
  }

  private patchTransientLines(lines: string[]) {
    if (!process.stdout.isTTY || this.transientLineCount === 0 || this.lastTransientLines.length !== lines.length) {
      this.redrawTransientLines(lines);
      return;
    }

    const changedRows = lines.flatMap((line, index) => (line === this.lastTransientLines[index] ? [] : [index]));
    if (changedRows.length === 0) return;

    if (this.transientLineCount > 1) process.stdout.write(`\u001b[${this.transientLineCount - 1}F`);
    else process.stdout.write('\r');

    let currentRow = 0;

    for (const row of changedRows) {
      const delta = row - currentRow;
      if (delta > 0) process.stdout.write(`\u001b[${delta}E`);
      else if (delta < 0) process.stdout.write(`\u001b[${-delta}F`);

      process.stdout.write('\u001b[2K\r');
      if (lines[row]) process.stdout.write(lines[row]);
      currentRow = row;
    }

    const lastRow = lines.length - 1;
    const delta = lastRow - currentRow;
    if (delta > 0) process.stdout.write(`\u001b[${delta}E`);
    else if (delta < 0) process.stdout.write(`\u001b[${-delta}F`);
    process.stdout.write('\r');

    this.lastTransientLines = [...lines];
  }

  private drawTransientLines(lines: string[]) {
    if (sameLines(lines, this.lastTransientLines)) return;

    if (this.lastTransientLines.length === 0 || this.transientLineCount === 0) {
      this.redrawTransientLines(lines);
      return;
    }

    this.patchTransientLines(lines);
  }

  private appendPermanentLines(lines: string[]) {
    if (lines.length === 0) return;
    this.clearTransientBlock();
    process.stdout.write(`${lines.join('\n')}\n`);
  }

  private getAnimatedAssistantIndex() {
    for (let index = this.state.historyEntries.length - 1; index >= 0; index -= 1) {
      const entry = this.state.historyEntries[index];
      if (entry.type !== 'entry') continue;
      if (entry.kind === EntryKind.User) return null;
      if (entry.kind === EntryKind.Assistant) return RAINBOW_PHRASE_PATTERN.test(entry.text) ? index : null;
    }

    return null;
  }

  private shouldRenderHistoryEntry(entry: HistoryEntry) {
    return entry.type !== 'entry' || entry.kind !== EntryKind.Reasoning || this.state.showThinking;
  }

  private flushCommittedHistory(ctx: ReturnType<typeof createRenderContext>) {
    const lines: string[] = [];
    const startsConversation = this.committedHistoryCount === 0;
    const animatedAssistantIndex = this.getAnimatedAssistantIndex();

    while (this.committedHistoryCount < this.state.historyEntries.length) {
      const index = this.committedHistoryCount;
      const entry = this.state.historyEntries[index];
      if (isCommandHistoryEntry(entry)) {
        const end = commandActivityEnd(this.state.historyEntries, index);
        const commands = this.state.historyEntries.slice(index, end) as ToolHistoryEntry[];
        if (commandActivityIsRunning(commands)) break;
        if (this.state.busy && end === this.state.historyEntries.length) break;
        lines.push(...serializeBlock(renderCommandActivity(commands, ctx)));
        if (
          this.state.historyEntries
            .slice(end)
            .some(nextEntry => this.shouldRenderHistoryEntry(nextEntry))
        ) {
          lines.push('');
        }
        this.committedHistoryCount = end;
        continue;
      }
      if (entry.type === 'tool' && entry.status === 'running') break;
      if (index === animatedAssistantIndex) break;

      if (this.shouldRenderHistoryEntry(entry)) lines.push(...serializeBlock(renderHistoryEntry(entry, ctx)));
      this.committedHistoryCount += 1;
    }

    if (startsConversation && lines.length > 0) lines.unshift('');
    this.appendPermanentLines(lines);
  }

  private renderTransientLines(ctx: ReturnType<typeof createRenderContext>, suggestions: ReturnType<AgentApp['normalizeSuggestions']>) {
    const animatedAssistantIndex = this.getAnimatedAssistantIndex();
    const pendingHistory: ReturnType<typeof renderHistoryEntry> = [];
    for (let index = this.committedHistoryCount; index < this.state.historyEntries.length;) {
      const entry = this.state.historyEntries[index];
      if (isCommandHistoryEntry(entry)) {
        const end = commandActivityEnd(this.state.historyEntries, index);
        pendingHistory.push(
          ...renderCommandActivity(
            this.state.historyEntries.slice(index, end) as ToolHistoryEntry[],
            ctx,
          ),
        );
        if (
          this.state.historyEntries
            .slice(end)
            .some(nextEntry => this.shouldRenderHistoryEntry(nextEntry))
        ) {
          pendingHistory.push(blankLine());
        }
        index = end;
        continue;
      }
      if (this.shouldRenderHistoryEntry(entry)) {
        pendingHistory.push(
          ...renderHistoryEntry(entry, ctx, {
            animateAssistant: index === animatedAssistantIndex,
          }),
        );
      }
      index += 1;
    }
    const preview = renderOutputPreview(
      this.state.showThinking ? this.state.liveReasoningText : '',
      this.state.liveAssistantText,
      ctx,
      this.state.pendingApproval,
    );
    const pendingInput = renderPendingInput(
      this.state.pendingSteers,
      this.state.queuedSubmissions,
      ctx,
    );
    const composer = renderComposer(
      {
        inputChars: this.state.inputChars,
        pasteRanges: this.state.pasteRanges,
        cursor: this.state.cursor,
        slashCommandLength: this.getSlashCommandLength(),
        skillNames: this.skills.map(skill => skill.name),
        showCapabilitiesHint: this.state.historyEntries.length === 0,
        placeholder: this.sideConversationActive
          ? 'Ask a follow-up question'
          : 'Describe a task or ask a question',
      },
      ctx,
    ).block;
    const choicePrompt = this.state.pendingChoice
      ? renderChoicePrompt(this.state.pendingChoice, this.state.pendingChoiceIndex, ctx)
      : null;
    const configPicker = this.state.configPicker
      ? renderConfigPicker(this.state.configPicker, ctx)
      : null;
    const suggestionLines = choicePrompt || configPicker
      ? []
      : renderSuggestions(suggestions, this.state.selectedSuggestion, ctx);
    const footer = choicePrompt || configPicker || suggestionLines.length > 0
      ? []
      : renderFooter(this.state, ctx);
    const statusIndicator = renderStatusIndicator(
      this.state,
      this.busyStartedAt === null ? 0 : Date.now() - this.busyStartedAt,
      this.backgroundTerminals.list().length,
    );

    const topSections = [pendingHistory, preview].filter(section => section.length > 0);
    const body = topSections.flatMap((section, index) => (index === 0 ? section : [blankLine(), ...section]));
    const bottomSections = [statusIndicator, pendingInput].filter(section => section.length > 0);
    const composerLead = bottomSections.length > 0
      ? [
          ...bottomSections.flatMap((section, index) =>
            index === 0 ? section : [blankLine(), ...section],
          ),
          blankLine(),
        ]
      : [blankLine()];
    const composerSurface = configPicker ?? choicePrompt ?? composer;
    const blocks = body.length > 0
      ? [body, composerLead, composerSurface, suggestionLines, footer]
      : [composerLead, composerSurface, suggestionLines, footer];

    return serializeBlock(vstack(...blocks));
  }

  private get state() {
    return this.store.getState();
  }

  private get sideConversationActive() {
    return this.sideConversation?.active === true;
  }

  private setBusy(busy: boolean) {
    if (busy && !this.state.busy) this.busyStartedAt = Date.now();
    if (!busy) this.busyStartedAt = null;
    this.store.setBusy(busy);
  }

  constructor(options: AgentAppOptions = {}) {
    this.store = createAgentStore(options.initialState);
    this.sessionId = options.sessionId ?? randomUUID();
    this.bootFromSnapshot = Boolean(options.initialState);
    this.modelOverride = options.model;
    this.thinkingModeOverride = options.thinkingMode;
    this.permissionModeOverride = options.permissionMode;
    this.initialPrompt = options.initialPrompt?.trim() || undefined;
    this.threadTitle = options.threadTitle?.trim() ? options.threadTitle.trim() : null;
    this.sessionRolloutPath = options.rolloutPath;
    this.sessionCreatedAt = options.sessionCreatedAt;
    this.sessionParentId = options.parentSessionId;
    this.sessionForkPoint = options.forkPoint;

    this.statusAnimationTimer = setInterval(() => {
      if (!this.state.busy || this.state.closed) return;
      this.scheduleRender();
    }, 32);
    this.statusAnimationTimer.unref();

    this.rainbowTimer = setInterval(() => {
      if (this.state.closed || !this.hasRainbowPhraseVisible()) return;
      this.scheduleRender();
    }, 33);
    this.rainbowTimer.unref();

    installSegmentContainingPolyfill();
  }

  async start() {
    await this.theme.sync();
    const mentionIndex = startMentionIndex(process.cwd());
    void mentionIndex.waitForReady().then(() => {
      if (this.state.closed || !this.headerPrinted) return;
      this.store.resetSelectedSuggestion();
      this.scheduleRender();
    });
    this.skills = discoverSkills();

    if (!this.bootFromSnapshot) {
      const preferences = await loadYetPreferences();
      this.store.setCurrentModel(preferences.model);
      this.store.setThinkingMode(preferences.reasoning);
      this.store.setFastModeEnabled(preferences.fastModeEnabled);
      this.store.setPermissionMode(preferences.permissions);
      this.store.setAutoCompactEnabled(preferences.autoCompactEnabled);
      this.store.setShowThinking(preferences.showThinking);
    }
    if (this.modelOverride) this.store.setCurrentModel(this.modelOverride);
    if (this.thinkingModeOverride) {
      if (!getSupportedThinkingModes(this.state.currentModel).includes(this.thinkingModeOverride))
        throw new Error(`${this.state.currentModel} does not support ${this.thinkingModeOverride} reasoning effort`);
      this.store.setThinkingMode(this.thinkingModeOverride);
    }
    if (this.permissionModeOverride) this.store.setPermissionMode(this.permissionModeOverride);
    this.sessionRecorder = await SessionRecorder.open({
      sessionId: this.sessionId,
      cwd: process.cwd(),
      rolloutPath: this.sessionRolloutPath,
      createdAt: this.sessionCreatedAt,
      title: this.threadTitle ?? undefined,
      parentSessionId: this.sessionParentId,
      forkPoint: this.sessionForkPoint,
    });
    this.sessionRolloutPath = this.sessionRecorder.rolloutPath;

    const { stream, buffer } = takeOverEarlyStdin();
    this.stdin = stream ?? process.stdin;

    if (this.stdin.isTTY) this.stdin.setRawMode(true);
    if (process.stdout.isTTY) process.stdout.write('\u001b[?25l\u001b[?2004h');
    this.stdin.resume();
    this.stdin.on('data', this.onStdinData);
    process.stdout.on('resize', this.render);

    this.render();
    for (const chunk of buffer) this.onStdinData(chunk);
    if (this.initialPrompt) this.startSubmissionTask(this.initialPrompt);
  }

  private prepareShutdown() {
    if (this.state.closed) return false;
    this.store.setClosed();

    clearInterval(this.statusAnimationTimer);
    clearInterval(this.rainbowTimer);
    this.backgroundTerminals.stopAll();
    if (this.renderTimer) clearTimeout(this.renderTimer);
    if (this.footerNoticeTimer) clearTimeout(this.footerNoticeTimer);
    process.stdout.off('resize', this.render);
    this.stdin.off('data', this.onStdinData);

    if (this.stdin.isTTY) this.stdin.setRawMode(false);
    this.stdin.pause();
    if (this.transcriptOpen && process.stdout.isTTY) {
      this.transcriptOpen = false;
      process.stdout.write(TRANSCRIPT_SCREEN_LEAVE);
    }
    this.clearTransientBlock();
    if (process.stdout.isTTY) process.stdout.write('\u001b[?25h\u001b[?2004l');

    this.threadTitleRequest?.cancel();
    this.threadTitleRequest = null;
    return true;
  }

  cleanup(code = 0) {
    if (!this.prepareShutdown()) return;

    if (code === 0) {
      const resumableSessionId = this.sideConversation?.parentSessionId ?? this.sessionId;
      const exitLines = serializeBlock(renderExitSummary(this.hasResumableSession() ? `yet --resume=${resumableSessionId}` : null));

      // The user sees the closing summary immediately. Only queued local writes remain afterward.
      if (exitLines.length > 0) process.stdout.write(`${exitLines.join('\n')}\n`);
    }

    void (async () => {
      try {
        await this.sessionRecorder?.close();
      } catch (error) {
        process.stderr.write(`warning: could not finish saving this session: ${plain(error instanceof Error ? error.message : String(error))}\n`);
      }
      process.exit(code);
    })();
  }

  private async deleteCurrentSession() {
    if (!this.prepareShutdown()) return;

    let code = 0;
    try {
      if (!this.sessionRecorder) throw new Error('session recorder is not available');
      await this.sessionRecorder.deleteSession();
    } catch (error) {
      code = 1;
      process.stderr.write(
        `error: could not delete this session: ${plain(error instanceof Error ? error.message : String(error))}\n`,
      );
    }
    process.exit(code);
  }

  handleFatalError(error: unknown, code = 1) {
    this.clearTransientBlock();
    if (process.stdout.isTTY) process.stdout.write('\u001b[?25h');
    process.stderr.write(`${plain(error instanceof Error ? error.stack || error.message : String(error))}\n`);
    this.cleanup(code);
  }

  private getSuggestions() {
    return listComposerSuggestions(this.state.inputChars, this.state.cursor, this.slashCommands, {
      currentModel: this.state.currentModel,
      thinkingMode: this.state.thinkingMode,
      skills: this.skills,
    });
  }

  private normalizeSuggestions() {
    const suggestions = this.getSuggestions();

    if (suggestions.length === 0) {
      this.store.resetSelectedSuggestion();
      return suggestions;
    }

    this.store.setSelectedSuggestion(Math.max(0, Math.min(this.state.selectedSuggestion, suggestions.length - 1)));
    return suggestions;
  }

  private getCurrentSlashCommand() {
    return this.slashCommands.parse(this.state.inputChars.join(''));
  }

  private getSlashCommandLength() {
    const parsed = this.getCurrentSlashCommand();
    return parsed?.type === 'resolved' ? parsed.invocation.length : 0;
  }

  private resetRenderedScreen() {
    this.clearTransientBlock();
    this.committedHistoryCount = 0;
    this.headerPrinted = false;

    if (process.stdout.isTTY) process.stdout.write('\u001b[2J\u001b[H');
  }

  private createCurrentRenderContext() {
    return createRenderContext(this.theme, false, process.stdout.columns || 100, process.stdout.rows || 30);
  }

  private printEphemeralEntries(entries: HistoryEntry[]) {
    if (entries.length === 0) return;
    const ctx = this.createCurrentRenderContext();
    const block = entries.flatMap((entry, index) =>
      index === 0 ? renderHistoryEntry(entry, ctx) : [blankLine(), ...renderHistoryEntry(entry, ctx)],
    );
    this.appendPermanentLines(serializeBlock(block));
  }

  private performRender = () => {
    this.renderScheduled = false;
    this.renderTimer = null;

    if (this.state.closed) return;

    const columns = process.stdout.columns || 100;
    const rows = process.stdout.rows || 30;
    const resized = this.lastRenderColumns > 0 && (columns !== this.lastRenderColumns || rows !== this.lastRenderRows);

    if (this.transcriptOpen) {
      const ctx = createRenderContext(this.theme, true, columns, rows);
      const historyRevision = this.store.getHistoryRevision();
      const reasoning = this.state.showThinking ? this.state.liveReasoningText : '';
      const assistant = this.state.liveAssistantText;
      const cached = this.transcriptContentCache;
      if (
        !cached ||
        cached.historyRevision !== historyRevision ||
        cached.width !== columns ||
        cached.reasoning !== reasoning ||
        cached.assistant !== assistant
      ) {
        this.transcriptContentCache = {
          historyRevision,
          width: columns,
          reasoning,
          assistant,
          content: renderTranscriptContent(
            this.state.historyEntries,
            { reasoning, assistant },
            ctx,
          ),
        };
      }
      const rendered = renderTranscriptViewport(
        this.transcriptContentCache?.content ?? [],
        this.transcriptScrollOffset,
        ctx,
      );
      this.transcriptScrollOffset = Math.min(this.transcriptScrollOffset, rendered.maxScroll);
      process.stdout.write(`\u001b[2J\u001b[H${serializeBlock(rendered.block).join('\n')}`);
      this.lastRenderColumns = columns;
      this.lastRenderRows = rows;
      this.lastRenderAt = Date.now();
      return;
    }

    if (resized) this.resetRenderedScreen();

    const suggestions = this.normalizeSuggestions();
    const ctx = createRenderContext(this.theme, false, columns, rows);

    this.lastRenderColumns = columns;
    this.lastRenderRows = rows;

    if (!this.headerPrinted) {
      this.appendPermanentLines(serializeBlock(renderHeader(ctx, this.state.permissionMode === 'full')));
      this.headerPrinted = true;
    }

    this.flushCommittedHistory(ctx);
    this.drawTransientLines(this.renderTransientLines(ctx, suggestions));
    this.lastRenderAt = Date.now();
  };

  private scheduleRender() {
    if (this.state.closed || this.renderScheduled) return;

    const delay = Math.max(0, 16 - (Date.now() - this.lastRenderAt));
    this.renderScheduled = true;
    this.renderTimer = setTimeout(this.performRender, delay);
    this.renderTimer.unref?.();
  }

  private render = () => {
    if (this.renderTimer) {
      clearTimeout(this.renderTimer);
      this.renderTimer = null;
      this.renderScheduled = false;
    }

    this.performRender();
  };

  private hasResumableSession() {
    return this.sideConversation
      ? this.sideConversation.parentState.historyEntries.length > 0
      : this.state.historyEntries.length > 0;
  }

  private hasRainbowPhraseVisible() {
    return RAINBOW_PHRASE_PATTERN.test(this.state.liveAssistantText) || this.getAnimatedAssistantIndex() !== null;
  }

  private showFooterNotice(text: string, durationMs = 2_000) {
    if (this.footerNoticeTimer) clearTimeout(this.footerNoticeTimer);

    this.store.setFooterNotice(text);
    this.render();

    this.footerNoticeTimer = setTimeout(() => {
      this.footerNoticeTimer = null;
      if (this.state.closed || this.state.footerNotice !== text) return;
      this.store.setFooterNotice(null);
      this.render();
    }, durationMs);
    this.footerNoticeTimer.unref?.();
  }

  private recordSessionEvent(event: Exclude<YetSessionEvent, { type: 'session_meta' }>) {
    if (this.sideConversationActive) return;
    this.sessionRecorder?.record(event);
  }

  private recordTurnContext() {
    this.recordSessionEvent(createTurnContextEvent(this.state));
  }

  private startThreadTitleGeneration(userMessage: string) {
    if (this.sideConversationActive || this.threadTitle || this.threadTitleRequest || this.state.closed) return;
    const expectedTitle = createProvisionalThreadTitle(userMessage);
    if (!expectedTitle) return;

    const sessionId = this.sessionId;
    this.setThreadTitle(expectedTitle, 'provisional');
    let request: BackgroundThreadTitleRequest;
    request = startBackgroundThreadTitle({
      userMessage,
      expectedTitle,
      getCurrentTitle: () => (!this.state.closed && this.sessionId === sessionId ? this.threadTitle : null),
      applyTitle: title => {
        if (this.state.closed || this.sessionId !== sessionId) return;
        this.setThreadTitle(title, 'generated', expectedTitle);
      },
      onSettled: () => {
        if (this.threadTitleRequest === request) this.threadTitleRequest = null;
      },
    });
    this.threadTitleRequest = request;
  }

  private async switchToSession(sessionId: string) {
    if (this.sideConversationActive)
      throw new Error("'/resume' is unavailable in side conversations. Press Ctrl+C to return to the main thread first.");
    this.discardDormantSideConversation();
    if (sessionId === this.sessionId) {
      this.showFooterNotice(`Already on ${this.threadTitle ?? 'this thread'}`);
      return;
    }

    const session = await loadYetSession(sessionId);
    if (!session) throw new Error(`No saved thread found for id '${sessionId}'.`);
    const nextRecorder = await SessionRecorder.open({
      sessionId: session.sessionId,
      cwd: session.cwd,
      rolloutPath: session.rolloutPath,
      createdAt: session.createdAt,
      title: session.name,
    });

    this.threadTitleRequest?.cancel();
    this.threadTitleRequest = null;
    try {
      await this.sessionRecorder?.close();
    } catch (error) {
      await nextRecorder.close().catch(() => {});
      throw error;
    }

    this.sessionRecorder = nextRecorder;
    this.sessionId = session.sessionId;
    this.sessionRolloutPath = session.rolloutPath;
    this.sessionCreatedAt = session.createdAt;
    this.sessionParentId = session.parentSessionId;
    this.sessionForkPoint = session.forkPoint;
    this.threadTitle = session.name?.trim() ? session.name.trim() : null;
    this.lastRequestId = null;
    this.historyNavigationIndex = null;
    this.historyNavigationDraft = '';
    this.preferredComposerColumn = null;
    this.sessionFileBaselines.clear();
    this.store.replaceState(hydrateStateFromSession(session));
    this.resetRenderedScreen();
    this.render();
    this.showFooterNotice(`Switched to ${this.threadTitle ?? 'Untitled thread'}`);
  }

  private async forkCurrentSession(name?: string) {
    if (this.sideConversationActive)
      throw new Error("'/fork' is unavailable in side conversations. Press Ctrl+C to return to the main thread first.");
    this.discardDormantSideConversation();
    if (!this.hasResumableSession())
      throw new Error('A thread must contain at least one turn before it can be forked.');
    if (!this.sessionRecorder) throw new Error('session recorder is not available');
    if (this.state.abortController)
      throw new Error("'/fork' is unavailable while a task is running.");

    await this.sessionRecorder.flush();
    const parentSessionId = this.sessionId;
    const parentTitle = this.threadTitle;
    const forkPoint = this.sessionRecorder.lastOrdinal;
    const childSessionId = randomUUID();
    const childCreatedAt = new Date().toISOString();
    const childState = cloneInactiveAgentState(this.state);
    childState.historyEntries.push({
      type: 'forked',
      parentSessionId,
      ...(parentTitle ? { parentTitle } : {}),
    });
    childState.historyEntries.push({
      type: 'resume_hint',
      command: `yet --resume=${parentSessionId}`,
    });

    const childRecorder = await SessionRecorder.open({
      sessionId: childSessionId,
      cwd: process.cwd(),
      createdAt: childCreatedAt,
      title: name,
      parentSessionId,
      forkPoint,
    });
    childRecorder.record({
      type: 'fork_snapshot',
      payload: { state: persistedStateFromAgentState(childState) },
    });
    if (name) {
      childRecorder.record({
        type: 'thread_name_updated',
        payload: { name, source: 'manual' },
      });
    }

    try {
      await childRecorder.flush();
      await this.sessionRecorder.close();
    } catch (error) {
      await childRecorder.deleteSession().catch(() => {});
      throw error;
    }

    this.threadTitleRequest?.cancel();
    this.threadTitleRequest = null;
    this.sessionRecorder = childRecorder;
    this.sessionId = childSessionId;
    this.sessionRolloutPath = childRecorder.rolloutPath;
    this.sessionCreatedAt = childCreatedAt;
    this.sessionParentId = parentSessionId;
    this.sessionForkPoint = forkPoint;
    this.threadTitle = name?.trim() ? name.trim() : null;
    this.lastRequestId = null;
    this.historyNavigationIndex = null;
    this.historyNavigationDraft = '';
    this.preferredComposerColumn = null;
    this.store.replaceState(childState);
    this.resetRenderedScreen();
    this.render();
  }

  private async startSideConversation(question?: string) {
    if (this.sideConversation) {
      throw new Error(
        'A side conversation is already open. Press Ctrl+C to return before starting another.',
      );
    }
    if (!this.hasResumableSession()) {
      throw new Error(
        "'/btw' is unavailable until the current conversation has started. Send a message first, then try /btw again.",
      );
    }
    if (this.state.abortController)
      throw new Error("'/btw' is unavailable while a task is running.");

    await this.sessionRecorder?.flush();
    const parentSessionId = this.sessionId;
    const parentTitle = this.threadTitle;
    const parentState = cloneInactiveAgentState(this.state);
    parentState.footerNotice = null;
    const sideSessionId = randomUUID();
    const sideState = createSideConversationState(
      parentState,
      parentSessionId,
      parentTitle ?? undefined,
    );
    this.sideConversation = {
      active: true,
      parentSessionId,
      parentState,
      parentTitle,
      parentLastRequestId: this.lastRequestId,
      parentRolloutPath: this.sessionRolloutPath,
      parentCreatedAt: this.sessionCreatedAt,
      parentLineageId: this.sessionParentId,
      parentForkPoint: this.sessionForkPoint,
      parentFileBaselines: new Map(this.sessionFileBaselines),
      sideSessionId,
      sideState,
      sideLastRequestId: null,
      sideFileBaselines: new Map(),
      closeRequested: false,
    };

    this.threadTitleRequest?.cancel();
    this.threadTitleRequest = null;
    this.sessionId = sideSessionId;
    this.sessionRolloutPath = undefined;
    this.sessionCreatedAt = undefined;
    this.sessionParentId = parentSessionId;
    this.sessionForkPoint = this.sessionRecorder?.lastOrdinal;
    this.threadTitle = null;
    this.lastRequestId = null;
    this.sessionFileBaselines.clear();
    this.store.replaceState(sideState);
    if (question) this.store.enqueueSubmission({ text: question });
    this.resetRenderedScreen();
    this.render();
  }

  private closeSideConversation() {
    const side = this.sideConversation;
    if (!side || !side.active || this.state.busy) return false;

    this.sideConversation = null;
    this.sessionId = side.parentSessionId;
    this.sessionRolloutPath = side.parentRolloutPath;
    this.sessionCreatedAt = side.parentCreatedAt;
    this.sessionParentId = side.parentLineageId;
    this.sessionForkPoint = side.parentForkPoint;
    this.threadTitle = side.parentTitle;
    this.lastRequestId = side.parentLastRequestId;
    this.sessionFileBaselines.clear();
    for (const [path, baseline] of side.parentFileBaselines) {
      this.sessionFileBaselines.set(path, baseline);
    }
    this.historyNavigationIndex = null;
    this.historyNavigationDraft = '';
    this.preferredComposerColumn = null;
    side.parentState.sideConversation = null;
    this.store.replaceState(side.parentState);
    this.resetRenderedScreen();
    this.render();
    return true;
  }

  private discardDormantSideConversation() {
    if (!this.sideConversation || this.sideConversation.active) return false;
    this.sideConversation = null;
    this.store.setSideConversation(null);
    return true;
  }

  private replaceSessionFileBaselines(baselines: Map<string, string | null>) {
    this.sessionFileBaselines.clear();
    for (const [path, baseline] of baselines) this.sessionFileBaselines.set(path, baseline);
  }

  private toggleSideConversation() {
    const side = this.sideConversation;
    if (!side) return false;
    if (this.state.busy || this.state.pendingApproval || this.state.pendingChoice) {
      this.showFooterNotice('Side switching is available after the current turn.');
      return true;
    }

    if (side.active) {
      side.sideState = cloneInactiveAgentState(this.state);
      side.sideLastRequestId = this.lastRequestId;
      side.sideFileBaselines = new Map(this.sessionFileBaselines);
      side.active = false;
      side.parentState.sideConversation = {
        parentSessionId: side.parentSessionId,
        ...(side.parentTitle ? { parentTitle: side.parentTitle } : {}),
        active: false,
      };

      this.sessionId = side.parentSessionId;
      this.sessionRolloutPath = side.parentRolloutPath;
      this.sessionCreatedAt = side.parentCreatedAt;
      this.sessionParentId = side.parentLineageId;
      this.sessionForkPoint = side.parentForkPoint;
      this.threadTitle = side.parentTitle;
      this.lastRequestId = side.parentLastRequestId;
      this.replaceSessionFileBaselines(side.parentFileBaselines);
      this.store.replaceState(side.parentState);
    } else {
      const parentState = cloneInactiveAgentState(this.state);
      parentState.sideConversation = null;
      side.parentState = parentState;
      side.parentTitle = this.threadTitle;
      side.parentLastRequestId = this.lastRequestId;
      side.parentRolloutPath = this.sessionRolloutPath;
      side.parentCreatedAt = this.sessionCreatedAt;
      side.parentLineageId = this.sessionParentId;
      side.parentForkPoint = this.sessionForkPoint;
      side.parentFileBaselines = new Map(this.sessionFileBaselines);
      side.active = true;
      side.sideState.sideConversation = {
        parentSessionId: side.parentSessionId,
        ...(side.parentTitle ? { parentTitle: side.parentTitle } : {}),
        active: true,
      };

      this.sessionId = side.sideSessionId;
      this.sessionRolloutPath = undefined;
      this.sessionCreatedAt = undefined;
      this.sessionParentId = side.parentSessionId;
      this.sessionForkPoint = this.sessionRecorder?.lastOrdinal;
      this.threadTitle = null;
      this.lastRequestId = side.sideLastRequestId;
      this.replaceSessionFileBaselines(side.sideFileBaselines);
      this.store.replaceState(side.sideState);
    }

    this.historyNavigationIndex = null;
    this.historyNavigationDraft = '';
    this.preferredComposerColumn = null;
    this.resetRenderedScreen();
    this.render();
    return true;
  }

  private async persistPreferences() {
    try {
      await saveYetPreferences({
        model: this.state.currentModel,
        reasoning: this.state.thinkingMode,
        fastModeEnabled: this.state.fastModeEnabled,
        permissions: this.state.permissionMode,
        autoCompactEnabled: this.state.autoCompactEnabled,
        showThinking: this.state.showThinking,
      });
    } catch (error) {
      this.showFooterNotice(
        `Couldn't save preferences: ${plain(error instanceof Error ? error.message : String(error))}`,
        5_000,
      );
    }
  }

  private setCurrentModel(model: string) {
    this.store.setCurrentModel(model);
    if (!getSupportedThinkingModes(model).includes(this.state.thinkingMode)) this.store.setThinkingMode('auto');
    this.store.resetLastUsage();
    void this.persistPreferences();
    this.recordTurnContext();
    this.render();
  }

  private setThinkingMode(thinkingMode: AgentState['thinkingMode']) {
    this.store.setThinkingMode(thinkingMode);
    void this.persistPreferences();
    this.recordTurnContext();
    this.render();
  }

  private setFastModeEnabled(enabled: boolean) {
    this.store.setFastModeEnabled(enabled);
    void this.persistPreferences();
    this.recordTurnContext();
    this.render();
  }

  private setPermissionMode(permissionMode: PermissionMode) {
    this.store.setPermissionMode(permissionMode);
    void this.persistPreferences();
    this.recordTurnContext();
    this.render();
  }

  private setPlanningMode(enabled: boolean) {
    this.store.setPlanningMode(enabled);
    this.store.resetLastUsage();
    this.recordTurnContext();
    this.render();
  }

  private setThreadTitle(title: string | null, source: ThreadNameSource = 'manual', expectedName?: string) {
    if (source === 'manual') {
      this.threadTitleRequest?.cancel();
      this.threadTitleRequest = null;
    }
    this.threadTitle = title?.trim() ? title.trim() : null;
    if (this.threadTitle) {
      this.recordSessionEvent({
        type: 'thread_name_updated',
        payload: {
          name: this.threadTitle,
          source,
          ...(expectedName ? { expectedName } : {}),
        },
      });
    }
    this.render();
  }

  private getActiveTools() {
    return this.tools;
  }

  private toolCallTitle(toolName: string, input: unknown, toolCallId?: string) {
    if (toolName !== 'write_stdin') return undefined;
    if (toolCallId) {
      const existing = this.state.historyEntries.find(
        entry => entry.type === 'tool' && entry.toolCallId === toolCallId,
      );
      if (existing?.type === 'tool' && existing.title) return existing.title;
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
    const sessionId = (input as Record<string, unknown>).session_id;
    return typeof sessionId === 'number'
      ? this.backgroundTerminals.commandFor(sessionId)
      : undefined;
  }

  private foldBackgroundInteractionIntoCommand(interaction: ToolHistoryEntry) {
    if (interaction.toolName !== 'write_stdin') return;
    if (!interaction.input || typeof interaction.input !== 'object' || Array.isArray(interaction.input)) return;
    const sessionId = (interaction.input as Record<string, unknown>).session_id;
    if (typeof sessionId !== 'number') return;

    const parseOutput = (entry: ToolHistoryEntry) => {
      if (typeof entry.output !== 'string') return null;
      try {
        const parsed = JSON.parse(entry.output) as unknown;
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? parsed as Record<string, unknown>
          : null;
      } catch {
        return null;
      }
    };
    const command = [...this.state.historyEntries].reverse().find(entry => {
      if (entry.type !== 'tool' || entry.toolName !== 'exec_command') return false;
      return parseOutput(entry)?.session_id === sessionId;
    });
    if (!command || command.type !== 'tool') return;
    const commandOutput = parseOutput(command);
    const interactionOutput = parseOutput(interaction);
    if (!commandOutput || !interactionOutput) return;

    const output = [commandOutput.output, interactionOutput.output]
      .filter(value => typeof value === 'string' && value.length > 0)
      .join('\n');
    const next: Record<string, unknown> = {
      ...commandOutput,
      output,
      wall_time_seconds: interactionOutput.wall_time_seconds ?? commandOutput.wall_time_seconds,
      ...(interactionOutput.exit_code === undefined
        ? { session_id: interactionOutput.session_id ?? sessionId }
        : { exit_code: interactionOutput.exit_code }),
      ...(interactionOutput.original_token_count === undefined
        ? {}
        : { original_token_count: interactionOutput.original_token_count }),
      ...(interactionOutput.error === undefined ? {} : { error: interactionOutput.error }),
    };
    if (interactionOutput.exit_code !== undefined || interactionOutput.error !== undefined) {
      delete next.session_id;
    }
    const updated: ToolHistoryEntry = {
      ...command,
      output: JSON.stringify(next),
      status:
        interactionOutput.error !== undefined ||
        (typeof interactionOutput.exit_code === 'number' && interactionOutput.exit_code !== 0)
          ? 'failed'
          : 'completed',
    };
    this.store.upsertToolEntry(updated);
    this.recordSessionEvent({ type: 'tool_result', payload: { entry: updated } });
  }

  private getLastAssistantResponse() {
    return getLastAssistantResponse(this.state.messages);
  }

  private getActiveToolSummaries() {
    const groups = new Map<unknown, { names: string[]; description: string | null }>();

    for (const tool of this.getActiveTools().list()) {
      const name = tool.name;
      const existing = groups.get(tool);
      if (existing) {
        existing.names.push(name);
        continue;
      }

      const description =
        typeof tool === 'object' && tool !== null && 'description' in tool && typeof tool.description === 'string' ? tool.description.trim() : null;

      groups.set(tool, { names: [name], description });
    }

    return [...groups.values()].sort((a, b) => a.names[0].localeCompare(b.names[0]));
  }

  private getRuntimeMessages(messages: AgentMessage[] = this.state.messages, planningMode = this.state.planningMode): AgentMessage[] {
    const permissionProfile = resolvePermissionProfile(this.state.permissionMode, {
      readOnly: planningMode,
    });
    const permissionPrompt = permissionProfile.sandboxMode === 'danger-full-access'
      ? '<permissions mode="full" sandbox="danger-full-access" approval-policy="never">The user explicitly enabled Full Access. Tools run without the workspace sandbox or approval prompts.</permissions>'
      : `<permissions mode="${this.state.permissionMode}" sandbox="${permissionProfile.sandboxMode}" approval-policy="${permissionProfile.approvalPolicy}" reviewer="${permissionProfile.approvalsReviewer}">Shell commands run in a network-denied managed sandbox. Use permissions="elevated" with a justification when internet access or work outside the workspace is necessary.</permissions>`;
    const planningModePrompt = planningMode
      ? [
          '<session-mode name="planning">',
          '- Planning mode is enabled for this turn.',
          '- Focus on discovery, tradeoffs, and a concrete step-by-step plan.',
          '- Do not make file edits or run mutating commands.',
          '- Use exec_command and write_stdin only for read-only inspection and do not call apply_patch.',
          '- End with a concise recommendation and plan.',
          '</session-mode>',
        ].join('\n')
      : '';
    const skillsPrompt = renderSkillsCatalog(this.skills);
    const runtimePrompt = [
      permissionPrompt,
      planningModePrompt,
      this.sideConversationActive ? SIDE_DEVELOPER_INSTRUCTIONS : '',
      skillsPrompt,
    ].filter(Boolean).join('\n\n');

    const [first, ...rest] = messages;
    if (first?.role === 'system' && typeof first.content === 'string') {
      return [{ ...first, content: `${first.content}\n\n${runtimePrompt}` }, ...rest];
    }

    return [{ role: 'system' as const, content: runtimePrompt }, ...messages];
  }

  private cycleThinkingMode() {
    const next = cycleThinkingMode(this.state.thinkingMode, this.state.currentModel);
    this.store.setThinkingMode(next);
    void this.persistPreferences();
    this.recordTurnContext();
    this.render();
    return next;
  }

  private openCommandArgumentPicker(commandName: string) {
    this.clearHistoryNavigation();
    this.resetPreferredComposerColumn();
    this.store.replaceInput(`/${commandName}`);
    this.store.resetSelectedSuggestion();
    this.render();
  }

  private shouldAutoCompact() {
    return this.state.autoCompactEnabled && this.state.lastPromptTokens >= getCompactionTriggerTokens(this.state.currentModel);
  }

  private openTranscript() {
    if (this.transcriptOpen || !process.stdout.isTTY) return;
    this.clearTransientBlock();
    this.transcriptOpen = true;
    this.transcriptScrollOffset = 0;
    this.transcriptContentCache = null;
    process.stdout.write(TRANSCRIPT_SCREEN_ENTER);
    this.render();
  }

  private closeTranscript() {
    if (!this.transcriptOpen) return;
    this.transcriptOpen = false;
    this.transcriptScrollOffset = 0;
    this.transcriptContentCache = null;
    this.transientLineCount = 0;
    this.lastTransientLines = [];
    if (process.stdout.isTTY) process.stdout.write(TRANSCRIPT_SCREEN_LEAVE);
    this.render();
  }

  private handleTranscriptBinding(binding: ReturnType<typeof resolveInputBinding>) {
    if (!this.transcriptOpen || !binding) return false;
    if (
      binding.type === 'toggleTranscript' ||
      binding.type === 'escape' ||
      binding.type === 'interrupt' ||
      (binding.type === 'insertText' && binding.text.toLowerCase() === 'q')
    ) {
      this.closeTranscript();
      return true;
    }
    if (binding.type === 'moveSuggestion') {
      this.transcriptScrollOffset = Math.max(0, this.transcriptScrollOffset - binding.delta);
      this.scheduleRender();
      return true;
    }
    if (binding.type === 'insertText' && (binding.text === 'k' || binding.text === 'j')) {
      this.transcriptScrollOffset = Math.max(
        0,
        this.transcriptScrollOffset + (binding.text === 'k' ? 1 : -1),
      );
      this.scheduleRender();
      return true;
    }
    if (binding.type === 'insertText' && binding.text === ' ') {
      const page = Math.max(1, (process.stdout.rows || 30) - 4);
      this.transcriptScrollOffset = Math.max(0, this.transcriptScrollOffset - page);
      this.scheduleRender();
      return true;
    }
    if (binding.type === 'pageTranscript') {
      const page = Math.max(1, (process.stdout.rows || 30) - 4);
      this.transcriptScrollOffset = Math.max(
        0,
        this.transcriptScrollOffset + binding.delta * page,
      );
      this.scheduleRender();
      return true;
    }
    if (binding.type === 'halfPageTranscript') {
      const contentHeight = Math.max(1, (process.stdout.rows || 30) - 4);
      const halfPage = Math.ceil(contentHeight / 2);
      this.transcriptScrollOffset = Math.max(
        0,
        this.transcriptScrollOffset + binding.delta * halfPage,
      );
      this.scheduleRender();
      return true;
    }
    if (binding.type === 'cursorHome') {
      this.transcriptScrollOffset = Number.MAX_SAFE_INTEGER;
      this.scheduleRender();
      return true;
    }
    if (binding.type === 'cursorEnd') {
      this.transcriptScrollOffset = 0;
      this.scheduleRender();
      return true;
    }
    return true;
  }

  private async refreshSessionFileChanges(paths: string[]) {
    const nextFileChanges = (
      await Promise.all(
        [...new Set(paths)].map(async path => {
          const absolutePath = resolve(process.cwd(), path);
          if (!this.sessionFileBaselines.has(absolutePath)) return null;
          const baselineContent = this.sessionFileBaselines.get(absolutePath) ?? null;
          const currentContent = await readOptionalFile(absolutePath);
          return createFileChange(relative(process.cwd(), absolutePath), baselineContent, currentContent);
        }),
      )
    ).filter((fileChange): fileChange is FileChange => fileChange !== null);

    if (nextFileChanges.length > 0) this.store.upsertSessionFileChanges(nextFileChanges);
  }

  private authorizeTool = async (request: ApprovalRequest, authorization: { requested: ToolPermission; potentiallyUnsafe?: boolean }) => {
    if (
      !shouldPromptForTool({
        mode: this.state.permissionMode,
        requested: authorization.requested,
        potentiallyUnsafe: authorization.potentiallyUnsafe,
      })
    )
      return true;
    return await this.requestApproval(request);
  };

  private requestApproval = async (request: ApprovalRequest) => {
    if (this.pendingApprovalResolver) throw new Error('another approval is already pending');

    const decision = await new Promise<ApprovalDecision>(resolve => {
      this.pendingApprovalResolver = resolve;
      this.store.setPendingApproval(request);
      this.render();
    });

    return decision !== 'deny';
  };

  private resolvePendingApproval(decision: ApprovalDecision) {
    const resolve = this.pendingApprovalResolver;
    if (!resolve || !this.state.pendingApproval) return false;

    this.pendingApprovalResolver = null;
    this.store.setPendingApproval(null);
    this.render();
    resolve(decision);
    return true;
  }

  private requestChoice = async (request: ChoiceRequest) => {
    if (this.pendingChoiceResolver) throw new Error('another choice is already pending');
    if (request.options.length < 2) throw new Error('choice prompt requires at least two options');

    const recommendedIndex = request.recommendedValue ? request.options.findIndex(option => option.value === request.recommendedValue) : -1;
    const selectedIndex = recommendedIndex >= 0 ? recommendedIndex : 0;

    const selection = await new Promise<ChoiceSelection | null>(resolve => {
      this.pendingChoiceResolver = resolve;
      this.store.setPendingChoice(request, selectedIndex);
      this.render();
    });

    return selection;
  };

  private resolvePendingChoice(selection: ChoiceSelection | null) {
    const resolve = this.pendingChoiceResolver;
    if (!resolve || !this.state.pendingChoice) return false;

    this.pendingChoiceResolver = null;
    this.store.setPendingChoice(null);
    this.render();
    resolve(selection);
    return true;
  }

  private openConfigPicker = async () => {
    if (this.configPickerResolver) throw new Error('configuration is already open');
    if (this.pendingChoiceResolver || this.pendingApprovalResolver)
      throw new Error('another prompt is already open');

    await new Promise<void>(resolve => {
      this.configPickerResolver = resolve;
      this.store.setConfigPicker(createConfigPickerState(this.state));
      this.render();
    });
  };

  private async closeConfigPicker() {
    const resolve = this.configPickerResolver;
    const picker = this.state.configPicker;
    if (!resolve || !picker) return false;

    this.configPickerResolver = null;
    const changed = applyConfigPickerState(this.store, picker);
    if (changed) {
      await this.persistPreferences();
      this.recordTurnContext();
    }
    this.store.setConfigPicker(null);
    resolve();
    return true;
  }

  private moveConfigPickerSelection(delta: number) {
    const picker = this.state.configPicker;
    if (!picker || picker.items.length === 0) return false;
    const nextIndex =
      (picker.selectedIndex + delta + picker.items.length) % picker.items.length;
    this.store.setConfigPickerSelectedIndex(nextIndex);
    this.render();
    return true;
  }

  private async handleConfigPickerBinding(binding: ReturnType<typeof resolveInputBinding>) {
    if (!this.state.configPicker || !binding) return false;

    if (
      binding.type === 'submit' ||
      binding.type === 'escape' ||
      binding.type === 'interrupt'
    ) {
      return await this.closeConfigPicker();
    }
    if (binding.type === 'moveSuggestion')
      return this.moveConfigPickerSelection(binding.delta);
    if (binding.type === 'insertText' && binding.text === ' ') {
      const toggled = this.store.toggleSelectedConfigPickerItem();
      if (toggled) this.render();
      return true;
    }

    return true;
  }

  private persistCompactionNotice(text: string) {
    const lastEntry = this.state.historyEntries[this.state.historyEntries.length - 1];
    if (lastEntry?.type === 'entry' && lastEntry.kind === EntryKind.Meta && lastEntry.text === text) {
      this.render();
      return;
    }

    this.persistEntry(EntryKind.Meta, text);
  }

  private async compactConversation(options: { manual?: boolean; force?: boolean } = {}) {
    const { manual = false, force = false } = options;

    if (this.state.compacting) return false;
    if (!manual && !this.shouldAutoCompact()) return false;

    if (!canCompactMessages(this.state.messages, undefined, force)) {
      if (manual) this.persistCompactionNotice('(not enough conversation history to compact)');
      return false;
    }

    this.store.setCompacting(true);
    this.render();

    try {
      const result = await compactMessages(this.state.messages, {
        force,
        model: this.state.currentModel,
        thinkingMode: this.state.thinkingMode,
        fastModeEnabled: this.state.fastModeEnabled,
      });
      this.store.replaceMessages(result.messages);
      this.store.setLastUsage(result.usage);
      const entry = {
        type: 'compacted',
        summary: result.summary,
        previousMessageCount: result.previousMessageCount,
        nextMessageCount: result.nextMessageCount,
        automatic: !manual,
      } as const;
      this.store.pushHistoryEntry(entry);
      this.recordSessionEvent({
        type: 'compacted',
        payload: { messages: result.messages, entry, usage: result.usage },
      });
      this.render();
      return true;
    } catch (error: unknown) {
      this.persistEntry(
        EntryKind.Error,
        `${manual ? 'compaction' : 'automatic compaction'} failed: ${plain(error instanceof Error ? error.message : String(error))}`,
      );
      return false;
    } finally {
      this.store.setCompacting(false);
      this.render();
    }
  }

  private persistHistoryEntries(entries: HistoryEntry[]) {
    for (const entry of entries) {
      this.store.pushHistoryEntry(entry);
      if (entry.type === 'tool') {
        this.recordSessionEvent({
          type: entry.status === 'running' ? 'tool_call' : 'tool_result',
          payload: { entry },
        });
      } else if (entry.type === 'entry' && entry.kind === EntryKind.User) {
        this.recordSessionEvent({ type: 'user_message', payload: { entries: [entry] } });
      } else if (entry.type === 'entry' && entry.kind === EntryKind.Assistant) {
        this.recordSessionEvent({ type: 'assistant_message', payload: { entries: [entry] } });
      } else if (entry.type === 'entry' && entry.kind === EntryKind.Reasoning) {
        this.recordSessionEvent({ type: 'reasoning', payload: { entries: [entry] } });
      } else if (entry.type !== 'compacted') {
        this.recordSessionEvent({ type: 'transcript_entry', payload: { entries: [entry] } });
      }
    }
    this.render();
  }

  private persistEntry(kind: EntryKind, text: string) {
    if (!text.trim()) return;
    this.persistHistoryEntries([{ type: 'entry', kind, text }]);
  }

  private persistPlain(text: string) {
    if (!text.trim()) return;
    this.persistHistoryEntries([{ type: 'plain', text }]);
  }

  private persistAnsi(text: string) {
    if (!text.trim()) return;
    this.persistHistoryEntries([{ type: 'ansi', text }]);
  }

  private persistLiveOutcome(entries: HistoryEntry[]) {
    this.store.clearLiveAssistantText();
    this.store.clearLiveReasoningText();
    this.store.resetLiveUsage();
    this.persistHistoryEntries(entries);
  }

  private persistCurrentLiveOutcome() {
    const entries: HistoryEntry[] = [
      ...(this.state.liveReasoningText.trim()
        ? [
            {
              type: 'entry',
              kind: EntryKind.Reasoning,
              text: this.state.liveReasoningText,
            } as const,
          ]
        : []),
      ...(this.state.liveAssistantText.trim()
        ? [
            {
              type: 'entry',
              kind: EntryKind.Assistant,
              text: this.state.liveAssistantText,
            } as const,
          ]
        : []),
    ];

    if (entries.length > 0) this.persistLiveOutcome(entries);
  }

  private async consumePendingSteers(signal?: AbortSignal): Promise<AgentMessage[]> {
    const pendingSteers = this.state.pendingSteers.slice();
    if (pendingSteers.length === 0) return [];

    const prepared = await Promise.all(
      pendingSteers.map(async submission => {
        const trimmed = submission.text.trim();
        const userContent = await this.buildUserMessageContent(trimmed);
        const skillInstructions = await loadSkillInstructionMessages(
          selectedSkills(trimmed, this.skills),
        );
        return {
          trimmed,
          skillInstructions,
          messages: [
            ...skillInstructions.messages,
            { role: 'user' as const, content: userContent },
          ],
        };
      }),
    );

    for (const steer of prepared) {
      await this.promptHistory.add(steer.trimmed, process.cwd());
    }

    signal?.throwIfAborted();
    this.store.takePendingSteers(pendingSteers.length);
    this.persistCurrentLiveOutcome();
    const messages: AgentMessage[] = [];

    for (const steer of prepared) {
      for (const warning of steer.skillInstructions.warnings) {
        this.persistEntry(EntryKind.Error, warning);
      }

      messages.push(...steer.messages);
      this.persistEntry(EntryKind.User, displayImageTokens(steer.trimmed));
      this.recordSessionEvent({
        type: 'user_message',
        payload: { messages: steer.messages },
      });
    }

    this.render();
    return messages;
  }

  private async expand(input: string) {
    let out = input;
    const imageMentions: Attachment[] = [];

    for (const match of input.match(/@[^\s]+/g) || []) {
      const path = match.slice(1);
      const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
      if (IMAGE_MEDIA_TYPES[ext]) {
        try {
          const attachment = await attachFromPath(path);
          imageMentions.push(attachment);
          out = out.replace(match, attachment.token);
        } catch {
          // fall through to text-mention behavior
        }
        continue;
      }
      try {
        const content = await readFile(path, 'utf8');
        out += `\n\n<file path="${path}">\n${content}\n</file>`;
      } catch {}
    }

    return out;
  }

  private async buildUserMessageContent(text: string): Promise<string | Array<AgentTextPart | AgentImagePart>> {
    const expanded = await this.expand(text);
    const tokens = extractTokens(expanded);
    if (tokens.length === 0) return expanded;

    const parts: Array<AgentTextPart | AgentImagePart> = [];
    let cursor = 0;
    IMAGE_TOKEN_PATTERN.lastIndex = 0;
    for (const match of expanded.matchAll(IMAGE_TOKEN_PATTERN)) {
      const matchStart = match.index ?? 0;
      const before = expanded.slice(cursor, matchStart).trimEnd();
      if (before.length > 0) parts.push({ type: 'text', text: before });
      const attachment = findAttachment(match[0]);
      if (attachment) {
        try {
          const bytes = await readFile(attachment.path);
          parts.push({
            type: 'image',
            dataUrl: `data:${attachment.mediaType};base64,${bytes.toString('base64')}`,
          });
        } catch {
          parts.push({ type: 'text', text: `[image unavailable: ${attachment.originalName}]` });
        }
      } else {
        parts.push({ type: 'text', text: match[0] });
      }
      cursor = matchStart + match[0].length;
    }
    const tail = expanded.slice(cursor).trimStart();
    if (tail.length > 0) parts.push({ type: 'text', text: tail });
    return parts.length > 0 ? parts : expanded;
  }

  private async runShellCommand(cmd: string) {
    const trimmedCommand = cmd.trim();
    this.store.setBusyStatusText(trimmedCommand);
    this.setBusy(true);
    this.render();

    try {
      const potentiallyUnsafe = isPotentiallyUnsafeCommand(trimmedCommand);
      const allowed = await this.authorizeTool(
        {
          scope: 'command',
          title: 'Run command',
          detail: trimmedCommand,
        },
        { requested: 'workspace', potentiallyUnsafe },
      );
      if (!allowed) throw new Error('command denied by user');
      const profile = resolvePermissionProfile(this.state.permissionMode, {
        readOnly: this.state.planningMode,
      });
      const result = await runUserShell(cmd, {
        workspaceRoot: process.cwd(),
        cwd: process.cwd(),
        sandboxMode: profile.sandboxMode,
      });
      const trimmed = result.output.trimEnd();

      this.persistEntry(EntryKind.Shell, `${trimmedCommand} exit ${result.exitCode}`);
      if (trimmed) this.persistAnsi(trimmed);
      else if (result.exitCode === 0) this.persistPlain('(no output)');
    } catch (error: unknown) {
      this.persistEntry(EntryKind.Error, plain(error instanceof Error ? error.message : String(error)));
    } finally {
      this.setBusy(false);
      this.render();
      void this.drainQueuedSubmissions();
    }
  }

  private async drainQueuedSubmissions() {
    if (this.drainingQueuedSubmissions || this.state.closed) return;

    this.drainingQueuedSubmissions = true;

    try {
      while (!this.state.closed && !this.state.busy) {
        const next = this.store.shiftQueuedSubmission();
        if (!next) break;

        this.render();
        await this.processSubmission(next);
      }
    } finally {
      this.drainingQueuedSubmissions = false;
    }
  }

  private createSlashCommandContext(): SlashCommandContext {
    return {
      store: this.store,
      cleanup: code => this.cleanup(code),
      deleteCurrentSession: () => this.deleteCurrentSession(),
      forkCurrentSession: name => this.forkCurrentSession(name),
      startSideConversation: question => this.startSideConversation(question),
      compactConversation: options => this.compactConversation(options),
      setCurrentModel: model => this.setCurrentModel(model),
      setThinkingMode: thinkingMode => this.setThinkingMode(thinkingMode),
      setFastModeEnabled: enabled => this.setFastModeEnabled(enabled),
      setPermissionMode: permissionMode => this.setPermissionMode(permissionMode),
      setPlanningMode: enabled => this.setPlanningMode(enabled),
      enqueueSubmission: (text, options) =>
        this.store.enqueueSubmission({ text, planningMode: options?.planningMode }),
      openCommandArgumentPicker: commandName => this.openCommandArgumentPicker(commandName),
      openConfigPicker: () => this.openConfigPicker(),
      requestChoice: request => this.requestChoice(request),
      showFooterNotice: (text, durationMs) => this.showFooterNotice(text, durationMs),
      getActiveToolSummaries: () => this.getActiveToolSummaries(),
      getSessionId: () => this.sessionId,
      switchToSession: sessionId => this.switchToSession(sessionId),
      getLastRequestId: () => this.lastRequestId,
      getLastAssistantResponse: () => this.getLastAssistantResponse(),
      getThreadTitle: () => this.threadTitle,
      getSessionLineage: () => ({
        ...(this.sessionParentId ? { parentSessionId: this.sessionParentId } : {}),
        ...(typeof this.sessionForkPoint === 'number'
          ? { forkPoint: this.sessionForkPoint }
          : {}),
        side: this.sideConversationActive,
      }),
      setThreadTitle: title => this.setThreadTitle(title),
      copyToClipboard: text => copyTextToClipboard(text),
      listBackgroundTerminals: () => this.backgroundTerminals.list(),
      stopBackgroundTerminals: () => this.backgroundTerminals.stopAll(),
      printEntries: entries => this.printEphemeralEntries(entries),
      persistEntries: entries => this.persistHistoryEntries(entries),
    };
  }

  private async runImmediateBackgroundCommand(command: ResolvedSlashCommand) {
    if (!['ps', 'stop'].includes(command.command.name)) return false;

    if (this.sideConversationActive) {
      this.persistEntry(
        EntryKind.Error,
        `/${command.invocation} is unavailable in side conversations. Press Ctrl+C to return to the main thread first.`,
      );
      return true;
    }

    try {
      await command.command.execute(this.createSlashCommandContext(), {
        raw: command.argsText
          ? `/${command.invocation} ${command.argsText}`
          : `/${command.invocation}`,
        invocation: command.invocation,
        argsText: command.argsText,
        argv: command.argv,
      });
    } catch (error: unknown) {
      this.persistEntry(
        EntryKind.Error,
        plain(error instanceof Error ? error.message : String(error)),
      );
    }
    return true;
  }

  private async processSubmission(submission: string | QueuedSubmission) {
    const queuedSubmission = typeof submission === 'string' ? { text: submission } : submission;
    const raw = queuedSubmission.text;
    const trimmed = raw.trim();

    if (!trimmed) return;

    const planningModeOverride = queuedSubmission.planningMode;
    const previousPlanningMode = planningModeOverride === undefined ? undefined : this.state.planningMode;

    if (planningModeOverride !== undefined && planningModeOverride !== this.state.planningMode) {
      this.store.setPlanningMode(planningModeOverride);
      this.store.resetLastUsage();
    }

    const slashCommand = this.slashCommands.parse(trimmed);
    if (slashCommand) {
      if (slashCommand.type === 'empty') {
        this.persistEntry(EntryKind.Error, 'missing slash command');
        return;
      }

      if (slashCommand.type === 'unknown') {
        this.persistEntry(EntryKind.Error, `unknown slash command: /${slashCommand.invocation}`);
        return;
      }

      if (
        this.sideConversationActive &&
        !['copy', 'status'].includes(slashCommand.command.name)
      ) {
        this.persistEntry(
          EntryKind.Error,
          `/${slashCommand.invocation} is unavailable in side conversations. Press Ctrl+C to return to the main thread first.`,
        );
        return;
      }

      this.store.setBusyStatusText(`/${slashCommand.invocation}`);
      this.setBusy(true);
      this.render();

      try {
        await slashCommand.command.execute(
          this.createSlashCommandContext(),
          {
            raw: trimmed,
            invocation: slashCommand.invocation,
            argsText: slashCommand.argsText,
            argv: slashCommand.argv,
          },
        );
      } catch (error: unknown) {
        this.persistEntry(EntryKind.Error, plain(error instanceof Error ? error.message : String(error)));
      } finally {
        this.setBusy(false);

        if (previousPlanningMode !== undefined && this.state.planningMode !== previousPlanningMode) {
          this.store.setPlanningMode(previousPlanningMode);
          this.store.resetLastUsage();
          this.recordTurnContext();
        }

        this.render();
        void this.drainQueuedSubmissions();
      }

      return;
    }

    if (trimmed.startsWith('!') && !this.sideConversationActive) {
      await this.runShellCommand(trimmed.slice(1));
      return;
    }

    await this.promptHistory.add(trimmed, process.cwd());
    const displayedUserMessage = displayImageTokens(trimmed);
    this.startThreadTitleGeneration(displayedUserMessage);
    this.recordTurnContext();
    this.persistEntry(EntryKind.User, displayedUserMessage);

    const abortController = createAbortController(this.store);
    let assistantStream: BlockStreamPump | null = null;
    let reasoningStream: BlockStreamPump | null = null;
    let interrupted = false;
    let immediateSteer: QueuedSubmission | null = null;

    this.setBusy(true);
    this.store.clearLiveAssistantText();
    this.store.clearLiveReasoningText();
    this.store.resetLiveUsage();
    this.render();

    try {
      if (this.shouldAutoCompact()) await this.compactConversation();

      const userContent = await this.buildUserMessageContent(trimmed);
      const userMessage = { role: 'user' as const, content: userContent };
      const invokedSkills = selectedSkills(trimmed, this.skills);
      const skillInstructions = await loadSkillInstructionMessages(invokedSkills);
      for (const warning of skillInstructions.warnings) this.persistEntry(EntryKind.Error, warning);

      const turnMessages = [...skillInstructions.messages, userMessage];
      this.store.pushMessages(turnMessages);
      this.recordSessionEvent({ type: 'user_message', payload: { messages: turnMessages } });

      const runtimeMessages = this.getRuntimeMessages();
      const estimatedPromptTokens = estimateMessageTokens(runtimeMessages);
      let completedPromptTokens = 0;
      let completedOutputTokens = 0;
      let completedReasoningTokens = 0;
      let completedCachedInputTokens = 0;
      let currentStepOutputText = '';
      let currentStepReasoningText = '';

      const syncLiveUsage = () => {
        this.store.setLiveUsage({
          inputTokens: completedPromptTokens > 0 ? completedPromptTokens : estimatedPromptTokens,
          outputTokens: completedOutputTokens + estimateTokenCount(currentStepOutputText),
          reasoningTokens: completedReasoningTokens + estimateTokenCount(currentStepReasoningText),
        });
      };

      assistantStream = new BlockStreamPump(text => {
        this.store.appendLiveAssistantText(text);
        syncLiveUsage();
        this.scheduleRender();
      });
      reasoningStream = new BlockStreamPump(text => {
        this.store.appendLiveReasoningText(text);
        syncLiveUsage();
        this.scheduleRender();
      });

      syncLiveUsage();
      this.render();

      const result = await runAgentLoop({
        model: this.state.currentModel,
        thinkingMode: this.state.thinkingMode,
        fastModeEnabled: this.state.fastModeEnabled,
        messages: runtimeMessages,
        tools: this.getActiveTools(),
        maxSteps: 20,
        signal: abortController.signal,
        takeSteers: signal => this.consumePendingSteers(signal),
        onEvent: async event => {
          if (abortController.signal.aborted || this.state.abortRequested) return;

          switch (event.type) {
            case 'reasoning-delta':
              currentStepReasoningText += event.text;
              reasoningStream?.push(event.text);
              break;
            case 'text-delta':
              currentStepOutputText += event.text;
              assistantStream?.push(event.text);
              break;
            case 'step-completed':
              reasoningStream?.flush();
              assistantStream?.flush();
              completedPromptTokens += event.usage.inputTokens;
              completedOutputTokens += event.usage.outputTokens;
              completedReasoningTokens += event.usage.reasoningTokens;
              completedCachedInputTokens += event.usage.cachedInputTokens;
              if (event.message) {
                this.recordSessionEvent({
                  type: 'assistant_message',
                  payload: { messages: [event.message] },
                });
              }
              this.recordSessionEvent({
                type: 'usage_updated',
                payload: {
                  usage: {
                    inputTokens: completedPromptTokens,
                    outputTokens: completedOutputTokens,
                    reasoningTokens: completedReasoningTokens,
                    cachedInputTokens: completedCachedInputTokens,
                  },
                  totalCost: this.state.totalCost,
                },
              });
              currentStepOutputText = '';
              currentStepReasoningText = '';
              syncLiveUsage();
              this.scheduleRender();
              break;
            case 'tool-call': {
              const inputRecord = event.call.input &&
                typeof event.call.input === 'object' &&
                !Array.isArray(event.call.input)
                ? event.call.input as Record<string, unknown>
                : null;
              const isBackgroundWait = event.call.name === 'write_stdin' &&
                inputRecord !== null &&
                (typeof inputRecord.chars !== 'string' || inputRecord.chars.length === 0);
              const title = this.toolCallTitle(event.call.name, event.call.input);
              if (isBackgroundWait) {
                this.backgroundWaitToolCallId = event.call.id;
                this.store.setBackgroundWaitCommand(title ?? 'background terminal');
              }
              const part = {
                toolCallId: event.call.id,
                toolName: event.call.name,
                input: event.call.input,
                title,
              };
              const entry = createPendingToolEntry(part);
              this.store.upsertToolEntry(entry);
              this.recordSessionEvent({
                type: 'tool_call',
                payload: { entry, message: event.message },
              });
              this.scheduleRender();
              break;
            }
            case 'tool-result': {
              const part = {
                toolCallId: event.call.id,
                toolName: event.call.name,
                input: event.call.input,
                output: event.result.output,
                title: this.toolCallTitle(event.call.name, event.call.input, event.call.id),
                fileChanges: event.result.fileChanges,
              };
              const entry = createCompletedToolEntry(part);
              this.store.upsertToolEntry(entry);
              if (this.backgroundWaitToolCallId === event.call.id) {
                this.backgroundWaitToolCallId = null;
                this.store.setBackgroundWaitCommand(null);
              }
              this.foldBackgroundInteractionIntoCommand(entry);
              this.recordSessionEvent({
                type: 'tool_result',
                payload: { entry, message: event.message },
              });
              if (event.result.fileChanges?.length) await this.refreshSessionFileChanges(event.result.fileChanges.map(fileChange => fileChange.path));
              this.scheduleRender();
              break;
            }
            case 'tool-error': {
              const entry = createFailedToolEntry({
                toolCallId: event.call.id,
                toolName: event.call.name,
                input: event.call.input,
                title: this.toolCallTitle(event.call.name, event.call.input, event.call.id),
                error: event.error,
              });
              this.store.upsertToolEntry(entry);
              if (this.backgroundWaitToolCallId === event.call.id) {
                this.backgroundWaitToolCallId = null;
                this.store.setBackgroundWaitCommand(null);
              }
              this.recordSessionEvent({
                type: 'tool_result',
                payload: { entry, message: event.message },
              });
              this.scheduleRender();
              break;
            }
          }
        },
      });

      abortController.signal.throwIfAborted();
      reasoningStream.flush();
      assistantStream.flush();
      this.lastRequestId = result.responseId;
      this.store.pushMessages(result.messages);
      this.store.setLastUsage(result.usage);
      this.persistLiveOutcome([
        ...(this.state.liveReasoningText.trim()
          ? [
              {
                type: 'entry',
                kind: EntryKind.Reasoning,
                text: this.state.liveReasoningText,
              } as const,
            ]
          : []),
        ...(this.state.liveAssistantText.trim()
          ? [
              {
                type: 'entry',
                kind: EntryKind.Assistant,
                text: this.state.liveAssistantText,
              } as const,
            ]
          : []),
      ]);
    } catch (error: unknown) {
      reasoningStream?.flush();
      assistantStream?.flush();
      if (abortController.signal.aborted) {
        interrupted = true;
        const shouldSubmitSteersImmediately = this.state.steerRequested;
        const pendingSteers = shouldSubmitSteersImmediately
          ? this.store.takePendingSteers()
          : [];
        if (pendingSteers.length > 0) {
          immediateSteer = {
            text: pendingSteers.map(submission => submission.text).join('\n'),
          };
        } else if (!shouldSubmitSteersImmediately) {
          this.restorePendingInputsToComposer();
        }

        this.persistLiveOutcome([
          ...(this.state.liveReasoningText.trim()
            ? [
                {
                  type: 'entry',
                  kind: EntryKind.Reasoning,
                  text: this.state.liveReasoningText,
                } as const,
              ]
            : []),
          ...(this.state.liveAssistantText.trim()
            ? [
                {
                  type: 'entry',
                  kind: EntryKind.Assistant,
                  text: this.state.liveAssistantText,
                } as const,
              ]
            : []),
          {
            type: 'entry',
            kind: EntryKind.Meta,
            text: immediateSteer
              ? 'Model interrupted to submit steer instructions.'
              : '■ Conversation interrupted - tell the model what to do differently',
          },
        ]);
      } else {
        if (this.state.pendingSteers.length > 0) {
          interrupted = true;
          this.restorePendingInputsToComposer();
        }
        this.persistLiveOutcome([
          ...(this.state.liveReasoningText.trim()
            ? [
                {
                  type: 'entry',
                  kind: EntryKind.Reasoning,
                  text: this.state.liveReasoningText,
                } as const,
              ]
            : []),
          ...(this.state.liveAssistantText.trim()
            ? [
                {
                  type: 'entry',
                  kind: EntryKind.Assistant,
                  text: this.state.liveAssistantText,
                } as const,
              ]
            : []),
          {
            type: 'entry',
            kind: EntryKind.Error,
            text: plain(error instanceof Error ? error.message : String(error)),
          },
        ]);
      }
    } finally {
      reasoningStream?.dispose();
      assistantStream?.dispose();
      this.store.clearLiveAssistantText();
      this.store.clearLiveReasoningText();
      this.store.resetLiveUsage();
      this.store.setAbortController(null);
      resetAbortState(this.store);
      this.setBusy(false);

      if (previousPlanningMode !== undefined && this.state.planningMode !== previousPlanningMode) {
        this.store.setPlanningMode(previousPlanningMode);
        this.store.resetLastUsage();
        this.recordTurnContext();
      }

      this.render();
    }

    if (this.sideConversationActive && this.sideConversation?.closeRequested) {
      this.closeSideConversation();
      return;
    }

    if (immediateSteer && !this.state.closed) {
      await this.processSubmission(immediateSteer);
      return;
    }

    if (!interrupted) void this.drainQueuedSubmissions();
  }

  private clearHistoryNavigation() {
    this.historyNavigationIndex = null;
    this.historyNavigationDraft = '';
  }

  private resetPreferredComposerColumn() {
    this.preferredComposerColumn = null;
  }

  private async getInputHistory() {
    const history = await this.promptHistory.listForWorkspace(process.cwd());
    return history.map(entry => entry.text);
  }

  private async moveInputHistory(delta: number) {
    const history = await this.getInputHistory();
    if (history.length === 0) return false;

    if (delta < 0) {
      if (this.historyNavigationIndex === null) {
        this.historyNavigationDraft = this.state.inputChars.join('');
        this.historyNavigationIndex = history.length - 1;
      } else {
        this.historyNavigationIndex = Math.max(0, this.historyNavigationIndex - 1);
      }

      this.resetPreferredComposerColumn();
      this.store.replaceInput(history[this.historyNavigationIndex]);
      this.store.resetSelectedSuggestion();
      this.render();
      return true;
    }

    if (this.historyNavigationIndex === null) return false;

    const nextIndex = this.historyNavigationIndex + 1;
    if (nextIndex >= history.length) {
      const draft = this.historyNavigationDraft;
      this.clearHistoryNavigation();
      this.resetPreferredComposerColumn();
      this.store.replaceInput(draft);
    } else {
      this.historyNavigationIndex = nextIndex;
      this.resetPreferredComposerColumn();
      this.store.replaceInput(history[nextIndex]);
    }

    this.store.resetSelectedSuggestion();
    this.render();
    return true;
  }

  private restorePendingInputsToComposer() {
    const pending = this.store.takePendingSteers();
    const queued = this.store.takeQueuedSubmissions();
    const restored = [...pending, ...queued]
      .map(submission => submission.text)
      .filter(text => text.length > 0)
      .join('\n');

    if (!restored) return;
    this.store.prependInput(`${restored}${this.state.inputChars.length > 0 ? '\n' : ''}`);
  }

  private interruptActiveTurn(submitPendingSteersImmediately: boolean) {
    if (!this.state.busy || !this.state.abortController) return false;
    this.store.setSteerRequested(
      submitPendingSteersImmediately && this.state.pendingSteers.length > 0,
    );
    return handleAbortKeypress(this.store);
  }

  private startSubmissionTask(submission: string | QueuedSubmission) {
    const task = this.processSubmission(submission);
    this.activeSubmissionTask = task;
    void task
      .catch(error => this.handleFatalError(error))
      .finally(() => {
        if (this.activeSubmissionTask === task) this.activeSubmissionTask = null;
      });
  }

  private async submit() {
    const raw = this.state.inputChars.join('');
    const trimmed = raw.trim();

    if (!trimmed) return;

    this.clearHistoryNavigation();
    this.resetPreferredComposerColumn();
    this.store.resetComposer();
    this.store.resetSelectedSuggestion();
    this.render();

    const slashCommand = this.slashCommands.parse(trimmed);
    if (
      this.state.busy &&
      slashCommand?.type === 'resolved' &&
      (await this.runImmediateBackgroundCommand(slashCommand))
    ) {
      return;
    }
    if (this.state.busy && this.state.abortController && !slashCommand) {
      this.store.enqueuePendingSteer({ text: raw });
      this.render();
      return;
    }

    if (
      this.activeSubmissionTask ||
      this.state.busy ||
      this.state.queuedSubmissions.length > 0 ||
      this.drainingQueuedSubmissions
    ) {
      this.store.enqueueSubmission({ text: raw });
      if (
        slashCommand?.type === 'resolved' &&
        slashCommand.command.name === 'btw'
      ) {
        this.showFooterNotice('Side starting...', 60_000);
      }
      this.render();
      void this.drainQueuedSubmissions();
      return;
    }

    this.startSubmissionTask(raw);
  }

  private queueComposerDraft() {
    if (!this.state.busy) return false;
    const raw = this.state.inputChars.join('');
    if (!raw.trim()) return false;

    this.clearHistoryNavigation();
    this.resetPreferredComposerColumn();
    this.store.resetComposer();
    this.store.resetSelectedSuggestion();
    this.store.enqueueSubmission({ text: raw });
    this.render();
    return true;
  }

  private editLatestQueuedSubmission() {
    if (this.getSuggestions().length > 0) return false;
    const submission = this.store.popQueuedSubmission();
    if (!submission) return false;

    this.clearHistoryNavigation();
    this.resetPreferredComposerColumn();
    this.store.replaceInput(submission.text);
    this.store.resetSelectedSuggestion();
    this.render();
    return true;
  }

  private insertText(text: string) {
    if (!text) return;
    this.historyNavigationIndex = null;
    this.resetPreferredComposerColumn();
    this.store.insertText(text);

    if (this.getSuggestions().length === 0) this.store.resetSelectedSuggestion();

    this.render();
  }

  private insertPastedText(text: string) {
    const normalized = normalizePtyOutput(text);
    if (!normalized) return;

    if (this.tryAttachDroppedImages(normalized)) return;

    this.historyNavigationIndex = null;
    this.resetPreferredComposerColumn();
    this.store.insertPastedText(normalized);

    if (this.getSuggestions().length === 0) this.store.resetSelectedSuggestion();

    this.render();
  }

  private async pasteClipboardImage() {
    try {
      const image = await readClipboardImage();
      const attachment = await attachFromBytes(
        image.bytes,
        image.mediaType,
        image.originalName,
      );
      this.historyNavigationIndex = null;
      this.resetPreferredComposerColumn();
      this.store.insertText(attachment.token);
      this.store.resetSelectedSuggestion();
      this.render();
    } catch (error) {
      this.persistEntry(
        EntryKind.Error,
        `Failed to paste image: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private tryAttachDroppedImages(text: string): boolean {
    const dropped = parseDroppedImagePaths(text, process.cwd());
    if (!dropped) return false;

    void (async () => {
      const tokens: string[] = [];
      const summaries: string[] = [];
      for (const file of dropped) {
        try {
          const attachment = await attachFromPath(file.absolutePath);
          tokens.push(attachment.token);
          summaries.push(attachment.originalName);
        } catch (error) {
          this.showFooterNotice(`couldn't attach ${file.absolutePath}: ${error instanceof Error ? error.message : 'error'}`);
        }
      }
      if (tokens.length === 0) return;
      this.historyNavigationIndex = null;
      this.resetPreferredComposerColumn();
      this.store.insertText(tokens.join(' '));
      this.showFooterNotice(`attached ${summaries.length === 1 ? summaries[0] : `${summaries.length} images`}`);
      this.render();
    })();
    return true;
  }

  private moveSuggestionSelection(delta: number) {
    const suggestions = this.getSuggestions();
    if (suggestions.length === 0) return false;

    this.resetPreferredComposerColumn();
    this.store.setSelectedSuggestion((this.state.selectedSuggestion + delta + suggestions.length) % suggestions.length);
    this.render();
    return true;
  }

  private moveComposerCursorVertical(delta: number) {
    const next = moveComposerCursorVertical(
      {
        inputChars: this.state.inputChars,
        pasteRanges: this.state.pasteRanges,
        cursor: this.state.cursor,
        slashCommandLength: this.getSlashCommandLength(),
      },
      Math.max(1, frameWidth() - 4),
      delta,
      this.preferredComposerColumn ?? undefined,
    );

    if (!next || next.cursor === this.state.cursor) return false;

    this.preferredComposerColumn = next.preferredColumn;
    this.store.setCursor(next.cursor);
    this.render();
    return true;
  }

  private tryAcceptSuggestion() {
    const suggestions = this.normalizeSuggestions();
    const accepted = acceptComposerSuggestion(this.store, suggestions);
    if (!accepted) return false;

    this.store.resetSelectedSuggestion();
    this.render();
    return true;
  }

  private async tryAcceptAndSubmitSlashCommandSuggestion() {
    const currentSlashCommand = this.getCurrentSlashCommand();
    if (currentSlashCommand?.type !== 'resolved') return false;

    const suggestions = this.normalizeSuggestions();
    const selectedSuggestion = suggestions[this.state.selectedSuggestion];
    if (selectedSuggestion?.kind !== 'slash-command') return false;
    if (selectedSuggestion.commandName !== currentSlashCommand.command.name) return false;

    if (selectedSuggestion.disabled) {
      this.showFooterNotice(selectedSuggestion.detail || 'Unavailable');
      return true;
    }

    const accepted = acceptComposerSuggestion(this.store, suggestions);
    if (!accepted) return false;

    const raw = this.state.inputChars.join('');
    this.clearHistoryNavigation();
    this.resetPreferredComposerColumn();
    this.store.resetComposer();
    this.store.resetSelectedSuggestion();
    this.render();

    if (!raw.trim()) return true;

    if (
      this.activeSubmissionTask ||
      this.state.busy ||
      this.state.queuedSubmissions.length > 0 ||
      this.drainingQueuedSubmissions
    ) {
      this.store.enqueueSubmission({ text: raw });
      this.render();
      void this.drainQueuedSubmissions();
      return true;
    }

    this.startSubmissionTask(raw);
    return true;
  }

  private getSelectedPendingChoice() {
    const pendingChoice = this.state.pendingChoice;
    if (!pendingChoice) return null;

    const option = pendingChoice.options[this.state.pendingChoiceIndex];
    if (!option) return null;

    return {
      ...option,
      index: this.state.pendingChoiceIndex,
    };
  }

  private movePendingChoice(delta: number) {
    const pendingChoice = this.state.pendingChoice;
    if (!pendingChoice || pendingChoice.options.length === 0) return false;

    const maxIndex = pendingChoice.options.length - 1;
    const nextIndex = Math.max(0, Math.min(maxIndex, this.state.pendingChoiceIndex + delta));
    if (nextIndex === this.state.pendingChoiceIndex) return true;

    this.store.setPendingChoiceIndex(nextIndex);
    this.render();
    return true;
  }

  private handlePendingChoiceBinding(binding: ReturnType<typeof resolveInputBinding>) {
    if (!this.state.pendingChoice || !binding) return false;

    if (binding.type === 'escape') return this.resolvePendingChoice(null);
    if (binding.type === 'submit') return this.resolvePendingChoice(this.getSelectedPendingChoice());
    if (binding.type === 'moveSuggestion') return this.movePendingChoice(binding.delta);
    if (binding.type !== 'insertText') return true;

    const key = binding.text.trim().toLowerCase();
    const digit = Number.parseInt(key, 10);
    if (Number.isFinite(digit) && digit >= 1 && digit <= this.state.pendingChoice.options.length) {
      const option = this.state.pendingChoice.options[digit - 1];
      return this.resolvePendingChoice({ ...option, index: digit - 1 });
    }

    return true;
  }

  private handlePendingApprovalBinding(binding: ReturnType<typeof resolveInputBinding>) {
    if (!this.state.pendingApproval || !binding) return false;

    if (binding.type === 'escape') return this.resolvePendingApproval('deny');
    if (binding.type !== 'insertText') return true;

    const key = binding.text.trim().toLowerCase();
    if (key === 'y') return this.resolvePendingApproval('allow-once');
    if (key === 'n') return this.resolvePendingApproval('deny');
    return true;
  }

  private handleEscape() {
    if (this.interruptActiveTurn(true)) {
      this.render();
      return;
    }
  }

  private handleDelete(backward: boolean) {
    const changed = backward ? this.store.deleteBackward() : this.store.deleteForward();
    if (!changed) return;

    this.historyNavigationIndex = null;
    this.resetPreferredComposerColumn();

    if (this.getSuggestions().length === 0) this.store.resetSelectedSuggestion();
    this.render();
  }

  private handleInputBinding = async (binding: ReturnType<typeof resolveInputBinding>) => {
    if (!binding) return;

    if (this.handleTranscriptBinding(binding)) return;

    if (binding.type === 'pasteImage') {
      await this.pasteClipboardImage();
      return;
    }

    if (await this.handleConfigPickerBinding(binding)) return;

    if (binding.type === 'interrupt') {
      if (this.sideConversationActive && this.state.inputChars.length === 0) {
        const side = this.sideConversation;
        if (this.state.pendingApproval) this.resolvePendingApproval('deny');
        if (this.state.pendingChoice) this.resolvePendingChoice(null);
        if (this.state.busy) {
          if (side) side.closeRequested = true;
          this.interruptActiveTurn(false);
          this.render();
        } else {
          this.closeSideConversation();
        }
        return;
      }

      if (this.interruptActiveTurn(false)) {
        this.render();
        return;
      }

      if (this.state.inputChars.length > 0) {
        this.clearHistoryNavigation();
        this.resetPreferredComposerColumn();
        this.store.resetComposer();
        this.store.resetSelectedSuggestion();
        this.render();
        return;
      }

      this.cleanup(0);
      return;
    }

    if (this.handlePendingChoiceBinding(binding)) return;
    if (this.handlePendingApprovalBinding(binding)) return;

    if (binding.type === 'escape') {
      this.handleEscape();
      return;
    }

    if (binding.type === 'toggleSideConversation') {
      this.toggleSideConversation();
      return;
    }

    if (binding.type === 'toggleTranscript') {
      this.openTranscript();
      return;
    }

    if (binding.type === 'toggleThinkingMode') {
      this.cycleThinkingMode();
      return;
    }

    if (binding.type === 'acceptSuggestion') {
      if (this.getSuggestions().length === 0 && this.queueComposerDraft()) return;
      this.tryAcceptSuggestion();
      return;
    }

    if (binding.type === 'editQueuedSubmission') {
      if (this.editLatestQueuedSubmission()) return;
      if (binding.fallback === 'up') {
        if (this.moveSuggestionSelection(-1)) return;
        if (this.moveComposerCursorVertical(-1)) return;
        await this.moveInputHistory(-1);
      } else {
        this.resetPreferredComposerColumn();
        this.store.moveCursor(-1);
        this.render();
      }
      return;
    }

    if (binding.type === 'submit') {
      if (await this.tryAcceptAndSubmitSlashCommandSuggestion()) return;
      if (this.getCurrentSlashCommand()?.type !== 'resolved' && this.tryAcceptSuggestion()) return;
      await this.submit();
      return;
    }

    switch (binding.type) {
      case 'moveSuggestion': {
        if (this.moveSuggestionSelection(binding.delta)) return;
        if (this.moveComposerCursorVertical(binding.delta)) return;
        await this.moveInputHistory(binding.delta);
        return;
      }
      case 'pageTranscript':
      case 'halfPageTranscript':
        return;
      case 'backspace':
        this.handleDelete(true);
        return;
      case 'delete':
        this.handleDelete(false);
        return;
      case 'moveCursor':
        this.resetPreferredComposerColumn();
        this.store.moveCursor(binding.delta);
        this.render();
        return;
      case 'cursorHome':
        this.resetPreferredComposerColumn();
        this.store.setCursor(0);
        this.render();
        return;
      case 'cursorEnd':
        this.resetPreferredComposerColumn();
        this.store.setCursor(this.state.inputChars.length);
        this.render();
        return;
      case 'insertText':
        this.insertText(binding.text);
        return;
      default:
        return;
    }
  };

  private processNonPasteInput = async (text: string) => {
    if (!text) return;

    const binding = resolveInputBinding(text);
    if (binding) {
      await this.handleInputBinding(binding);
      return;
    }

    if (!text.includes('\u001b')) this.insertText(text);
  };

  private drainStdinBuffer = async () => {
    while (this.stdinBuffer.length > 0) {
      if (this.bracketedPasteActive) {
        const endIndex = this.stdinBuffer.indexOf(BRACKETED_PASTE_END);
        if (endIndex === -1) {
          this.bracketedPasteBuffer += this.stdinBuffer;
          this.stdinBuffer = '';
          return;
        }

        this.bracketedPasteBuffer += this.stdinBuffer.slice(0, endIndex);
        this.stdinBuffer = this.stdinBuffer.slice(endIndex + BRACKETED_PASTE_END.length);
        this.bracketedPasteActive = false;
        this.insertPastedText(this.bracketedPasteBuffer);
        this.bracketedPasteBuffer = '';
        continue;
      }

      const startIndex = this.stdinBuffer.indexOf(BRACKETED_PASTE_START);
      if (startIndex !== -1) {
        const before = this.stdinBuffer.slice(0, startIndex);
        this.stdinBuffer = this.stdinBuffer.slice(startIndex + BRACKETED_PASTE_START.length);
        if (before) await this.processNonPasteInput(before);
        this.bracketedPasteActive = true;
        this.bracketedPasteBuffer = '';
        continue;
      }

      const suffixLength = bracketedPasteSuffixLength(this.stdinBuffer);
      const complete = this.stdinBuffer.slice(0, this.stdinBuffer.length - suffixLength);
      this.stdinBuffer = this.stdinBuffer.slice(this.stdinBuffer.length - suffixLength);

      if (complete) {
        const split = splitInputEvents(complete);
        for (const event of split.events) await this.processNonPasteInput(event);
        this.stdinBuffer = split.remainder + this.stdinBuffer;
      }
      return;
    }
  };

  private onStdinData = (chunk: Buffer | string) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    this.stdinBuffer += text;
    this.stdinTask = this.stdinTask
      .then(this.drainStdinBuffer)
      .catch(error => {
        this.persistEntry(
          EntryKind.Error,
          `Failed to process input: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  };
}
