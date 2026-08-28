import ora from 'ora';
import { createTheme } from '@/theme';
import { createToolRegistry } from '@/tools';
import { runUserShell } from './shell';
import { randomUUID } from 'node:crypto';
import { relative, resolve } from 'node:path';
import { refreshGitBranch } from '@/git';
import { readFile } from 'node:fs/promises';
import { resolveInputBinding } from './keybinds';
import { takeOverEarlyStdin } from './early-stdin';
import { startMentionIndex } from './mention-index';
import { PromptHistoryStore } from './prompt-history';
import { blankLine, vstack } from '@/render/primitives';
import { pickSpinnerVerb } from '@/render/spinner-verbs';
import { renderFooter } from '@/render/components/footer';
import type { ReadStream as TtyReadStream } from 'node:tty';
import { renderHistoryEntry } from '@/render/components/entry';
import { compactMessages, canCompactMessages } from './compact';
import { renderSuggestions } from '@/render/components/suggestions';
import { renderOutputPreview } from '@/render/components/transcript';
import { renderQueuedSubmissions } from '@/render/components/queued';
import { IMAGE_MEDIA_TYPES, parseDroppedImagePaths } from './path-detect';
import { copyTextToClipboard } from './clipboard-text';
import { createFileChange, readOptionalFile } from '@/file-changes';
import { builtinSlashCommands, createSlashCommandRegistry } from './slash-commands';
import {
  createTurnContextEvent,
  hydrateStateFromSession,
  loadYetSession,
  SessionRecorder,
  type ThreadNameSource,
  type YetSessionEvent,
} from './session-storage';
import {
  createProvisionalThreadTitle,
  startBackgroundThreadTitle,
  type BackgroundThreadTitleRequest,
} from './thread-title';
import { normalizePtyOutput, plain, installSegmentContainingPolyfill } from '@/text';
import { handleAbortKeypress, createAbortController, resetAbortState } from './abort';
import { renderComposer, moveComposerCursorVertical } from '@/render/components/composer';
import { acceptComposerSuggestion, listComposerSuggestions } from './composer-suggestions';
import { createAgentStore, type AgentState, type AgentStore, type QueuedSubmission } from '@/store';

import {
  attachFromPath,
  extractTokens,
  findAttachment,
  IMAGE_TOKEN_PATTERN,
  replaceTokensWithSummary,
  type Attachment,
} from './image-attachments';

import {
  createRenderContext,
  frameWidth,
  renderExitSummary,
  renderHeader,
  serializeBlock,
} from '@/render';

import {
  getLastAssistantResponse,
  type AgentImagePart,
  type AgentMessage,
  type AgentTextPart,
} from './messages';
import { runAgentLoop } from './runner';
import {
  shouldPromptForTool,
  type PermissionMode,
  type ToolPermission,
} from '@/permissions';

import {
  createFailedToolEntry,
  createPendingToolEntry,
  createCompletedToolEntry,
} from './tool-history';

import {
  cycleThinkingMode,
  getCompactionTriggerTokens,
  getSupportedThinkingModes,
  loadYetPreferences,
  saveYetPreferences,
} from '@/config';

import {
  EntryKind,
  type ApprovalDecision,
  type ApprovalRequest,
  type ChoiceRequest,
  type ChoiceSelection,
  type FileChange,
  type HistoryEntry,
} from '@/types';

const RAINBOW_PHRASE_PATTERN = /you'?re absolutely right/i;
const BRACKETED_PASTE_START = '\u001b[200~';
const BRACKETED_PASTE_END = '\u001b[201~';

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
  return messages.reduce(
    (sum, message) => sum + estimateValueTokens('content' in message ? message.content : message),
    0,
  );
}

export type AgentAppOptions = {
  initialState?: AgentState;
  sessionId?: string;
  threadTitle?: string;
  rolloutPath?: string;
  sessionCreatedAt?: string;
  model?: string;
  thinkingMode?: AgentState['thinkingMode'];
  permissionMode?: PermissionMode;
};

export class AgentApp {
  private readonly store: AgentStore;
  private readonly theme = createTheme();
  private readonly spinner = ora({ spinner: 'dots10', color: 'green', isEnabled: false });
  private readonly commandSpinner = ora({ spinner: 'dots3', color: 'yellow', isEnabled: false });
  private busySpinnerVerb = pickSpinnerVerb();

  private transientLineCount = 0;
  private committedHistoryCount = 0;
  private headerPrinted = false;
  private lastTransientLines: string[] = [];
  private lastRenderColumns = 0;
  private lastRenderRows = 0;
  private expandPreviews = false;
  private readonly sessionFileBaselines = new Map<string, string | null>();

  private readonly tools = createToolRegistry({
    workspaceRoot: process.cwd(),
    runUserShell,
    authorize: (request, authorization) => this.authorizeTool(request, authorization),
    getPermissionMode: () => this.state.permissionMode,
    getPlanningMode: () => this.state.planningMode,
    getThinkingMode: () => this.state.thinkingMode,
    recordFileMutations: files => {
      if (!files.some(file => file.previousContent !== file.nextContent)) return;
      for (const file of files) {
        if (!this.sessionFileBaselines.has(file.path))
          this.sessionFileBaselines.set(file.path, file.previousContent);
      }
    },
  });
  private readonly slashCommands = createSlashCommandRegistry(builtinSlashCommands, {
    getSessionId: () => this.sessionId,
  });

  private readonly spinnerTimer: ReturnType<typeof setInterval>;
  private readonly rainbowTimer: ReturnType<typeof setInterval>;
  private sessionId: string;
  private readonly promptHistory = new PromptHistoryStore();
  private readonly bootFromSnapshot: boolean;
  private readonly modelOverride?: string;
  private readonly thinkingModeOverride?: AgentState['thinkingMode'];
  private readonly permissionModeOverride?: PermissionMode;
  private lastRequestId: string | null = null;
  private threadTitle: string | null;
  private threadTitleRequest: BackgroundThreadTitleRequest | null = null;
  private sessionRecorder: SessionRecorder | null = null;
  private sessionRolloutPath?: string;
  private sessionCreatedAt?: string;
  private drainingQueuedSubmissions = false;
  private renderTimer: ReturnType<typeof setTimeout> | null = null;
  private footerNoticeTimer: ReturnType<typeof setTimeout> | null = null;
  private renderScheduled = false;
  private lastRenderAt = 0;
  private historyNavigationIndex: number | null = null;
  private historyNavigationDraft = '';
  private preferredComposerColumn: number | null = null;
  private pendingApprovalResolver: ((decision: ApprovalDecision) => void) | null = null;
  private pendingChoiceResolver: ((selection: ChoiceSelection | null) => void) | null = null;
  private stdin: TtyReadStream = process.stdin;
  private bracketedPasteActive = false;
  private bracketedPasteBuffer = '';
  private stdinBuffer = '';

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
    if (
      !process.stdout.isTTY ||
      this.transientLineCount === 0 ||
      this.lastTransientLines.length !== lines.length
    ) {
      this.redrawTransientLines(lines);
      return;
    }

    const changedRows = lines.flatMap((line, index) =>
      line === this.lastTransientLines[index] ? [] : [index],
    );
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
      if (entry.kind === EntryKind.Assistant)
        return RAINBOW_PHRASE_PATTERN.test(entry.text) ? index : null;
    }

    return null;
  }

  private shouldRenderHistoryEntry(entry: HistoryEntry) {
    return entry.type !== 'entry' || entry.kind !== EntryKind.Reasoning || this.state.showThinking;
  }

  private flushCommittedHistory(ctx: ReturnType<typeof createRenderContext>) {
    const lines: string[] = [];
    const animatedAssistantIndex = this.getAnimatedAssistantIndex();

    while (this.committedHistoryCount < this.state.historyEntries.length) {
      const index = this.committedHistoryCount;
      const entry = this.state.historyEntries[index];
      if (entry.type === 'tool' && entry.status === 'running') break;
      if (index === animatedAssistantIndex) break;

      if (this.shouldRenderHistoryEntry(entry)) lines.push(...serializeBlock(renderHistoryEntry(entry, ctx)), '');
      this.committedHistoryCount += 1;
    }

    this.appendPermanentLines(lines);
  }

  private renderTransientLines(
    ctx: ReturnType<typeof createRenderContext>,
    suggestions: ReturnType<AgentApp['normalizeSuggestions']>,
  ) {
    const animatedAssistantIndex = this.getAnimatedAssistantIndex();
    const pendingHistory = this.state.historyEntries
      .slice(this.committedHistoryCount)
      .flatMap((entry, offset) => {
        const index = this.committedHistoryCount + offset;
        if (!this.shouldRenderHistoryEntry(entry)) return [];
        return [
          ...renderHistoryEntry(entry, ctx, { animateAssistant: index === animatedAssistantIndex }),
          blankLine(),
        ];
      });
    const preview = renderOutputPreview(
      this.state.showThinking ? this.state.liveReasoningText : '',
      this.state.liveAssistantText,
      ctx,
      this.state.pendingApproval,
      this.state.pendingChoice,
      this.state.pendingChoiceIndex,
    );
    const queued = renderQueuedSubmissions(this.state.queuedSubmissions, ctx, 8);
    const composer = renderComposer(
      {
        inputChars: this.state.inputChars,
        pasteRanges: this.state.pasteRanges,
        cursor: this.state.cursor,
        slashCommandLength: this.getSlashCommandLength(),
        showCapabilitiesHint: this.state.historyEntries.length === 0,
      },
      ctx,
    ).block;
    const suggestionLines = renderSuggestions(suggestions, this.state.selectedSuggestion, ctx);
    const footer = renderFooter(this.state, ctx);

    const topSections = [pendingHistory, preview, queued].filter(section => section.length > 0);
    const body = topSections.flatMap((section, index) =>
      index === 0 ? section : [blankLine(), ...section],
    );
    const blocks =
      body.length > 0
        ? [body, [blankLine()], composer, suggestionLines, footer]
        : [composer, suggestionLines, footer];

    return serializeBlock(vstack(...blocks));
  }

  private get state() {
    return this.store.getState();
  }

  private setBusy(busy: boolean) {
    if (busy && !this.state.busy) this.busySpinnerVerb = pickSpinnerVerb();
    this.store.setBusy(busy);
  }

  constructor(options: AgentAppOptions = {}) {
    this.store = createAgentStore(options.initialState);
    this.sessionId = options.sessionId ?? randomUUID();
    this.bootFromSnapshot = Boolean(options.initialState);
    this.modelOverride = options.model;
    this.thinkingModeOverride = options.thinkingMode;
    this.permissionModeOverride = options.permissionMode;
    this.threadTitle = options.threadTitle?.trim() ? options.threadTitle.trim() : null;
    this.sessionRolloutPath = options.rolloutPath;
    this.sessionCreatedAt = options.sessionCreatedAt;

    this.spinnerTimer = setInterval(() => {
      if (!this.state.busy || this.state.closed) return;
      this.scheduleRender();
    }, 80);
    this.spinnerTimer.unref();

    this.rainbowTimer = setInterval(() => {
      if (this.state.closed || !this.hasRainbowPhraseVisible()) return;
      this.scheduleRender();
    }, 33);
    this.rainbowTimer.unref();

    installSegmentContainingPolyfill();
  }

  async start() {
    await this.theme.sync();
    await refreshGitBranch(process.cwd());
    startMentionIndex(process.cwd());

    if (!this.bootFromSnapshot) {
      const preferences = await loadYetPreferences();
      this.store.setCurrentModel(preferences.model);
      this.store.setThinkingMode(preferences.reasoning);
      this.store.setPermissionMode(preferences.permissions);
      this.store.setAutoCompactEnabled(preferences.autoCompactEnabled);
    }
    if (this.modelOverride) this.store.setCurrentModel(this.modelOverride);
    if (this.thinkingModeOverride) {
      if (!getSupportedThinkingModes(this.state.currentModel).includes(this.thinkingModeOverride))
        throw new Error(
          `${this.state.currentModel} does not support ${this.thinkingModeOverride} reasoning effort`,
        );
      this.store.setThinkingMode(this.thinkingModeOverride);
    }
    if (this.permissionModeOverride) this.store.setPermissionMode(this.permissionModeOverride);
    this.sessionRecorder = await SessionRecorder.open({
      sessionId: this.sessionId,
      cwd: process.cwd(),
      rolloutPath: this.sessionRolloutPath,
      createdAt: this.sessionCreatedAt,
      title: this.threadTitle ?? undefined,
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
  }

  cleanup(code = 0) {
    if (this.state.closed) return;
    this.store.setClosed();

    clearInterval(this.spinnerTimer);
    clearInterval(this.rainbowTimer);
    if (this.renderTimer) clearTimeout(this.renderTimer);
    if (this.footerNoticeTimer) clearTimeout(this.footerNoticeTimer);
    process.stdout.off('resize', this.render);
    this.stdin.off('data', this.onStdinData);

    if (this.stdin.isTTY) this.stdin.setRawMode(false);
    this.stdin.pause();
    this.clearTransientBlock();
    if (process.stdout.isTTY) process.stdout.write('\u001b[?25h\u001b[?2004l');

    if (code === 0) {
      const exitLines = serializeBlock(
        renderExitSummary({
          threadTitle: this.threadTitle,
          threadUrl: null,
          resumeCommand: this.hasResumableSession() ? `yet --resume=${this.sessionId}` : null,
        }),
      );

      // The user sees the closing summary immediately. Only queued local writes remain afterward.
      process.stdout.write(`${exitLines.join('\n')}\n`);
    }

    this.threadTitleRequest?.cancel();
    this.threadTitleRequest = null;

    void (async () => {
      try {
        await this.sessionRecorder?.close();
      } catch (error) {
        process.stderr.write(
          `warning: could not finish saving this session: ${plain(error instanceof Error ? error.message : String(error))}\n`,
        );
      }
      process.exit(code);
    })();
  }

  handleFatalError(error: unknown, code = 1) {
    this.clearTransientBlock();
    if (process.stdout.isTTY) process.stdout.write('\u001b[?25h');
    process.stderr.write(
      `${plain(error instanceof Error ? error.stack || error.message : String(error))}\n`,
    );
    this.cleanup(code);
  }

  private getSuggestions() {
    return listComposerSuggestions(this.state.inputChars, this.state.cursor, this.slashCommands, {
      currentModel: this.state.currentModel,
      thinkingMode: this.state.thinkingMode,
    });
  }

  private normalizeSuggestions() {
    const suggestions = this.getSuggestions();

    if (suggestions.length === 0) {
      this.store.resetSelectedSuggestion();
      return suggestions;
    }

    this.store.setSelectedSuggestion(
      Math.max(0, Math.min(this.state.selectedSuggestion, suggestions.length - 1)),
    );
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
    return createRenderContext(
      this.theme,
      this.spinner.frame().trim(),
      this.commandSpinner.frame().trim(),
      this.busySpinnerVerb,
      this.expandPreviews,
      process.stdout.columns || 100,
      process.stdout.rows || 30,
    );
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
    const resized =
      this.lastRenderColumns > 0 &&
      (columns !== this.lastRenderColumns || rows !== this.lastRenderRows);

    if (resized) this.resetRenderedScreen();

    const suggestions = this.normalizeSuggestions();
    const ctx = createRenderContext(
      this.theme,
      this.spinner.frame().trim(),
      this.commandSpinner.frame().trim(),
      this.busySpinnerVerb,
      this.expandPreviews,
      columns,
      rows,
    );

    this.lastRenderColumns = columns;
    this.lastRenderRows = rows;

    if (!this.headerPrinted) {
      this.appendPermanentLines(serializeBlock(renderHeader(ctx)));
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
    return this.state.historyEntries.length > 0;
  }

  private shouldConfirmExit() {
    return this.hasResumableSession();
  }

  private hasRainbowPhraseVisible() {
    return (
      RAINBOW_PHRASE_PATTERN.test(this.state.liveAssistantText) ||
      this.getAnimatedAssistantIndex() !== null
    );
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
    this.sessionRecorder?.record(event);
  }

  private recordTurnContext() {
    this.recordSessionEvent(createTurnContextEvent(this.state));
  }

  private startThreadTitleGeneration(userMessage: string) {
    if (this.threadTitle || this.threadTitleRequest || this.state.closed) return;
    const expectedTitle = createProvisionalThreadTitle(userMessage);
    if (!expectedTitle) return;

    const sessionId = this.sessionId;
    this.setThreadTitle(expectedTitle, 'provisional');
    let request: BackgroundThreadTitleRequest;
    request = startBackgroundThreadTitle({
      userMessage,
      expectedTitle,
      getCurrentTitle: () =>
        !this.state.closed && this.sessionId === sessionId ? this.threadTitle : null,
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

  private persistPreferences() {
    void saveYetPreferences({
      model: this.state.currentModel,
      reasoning: this.state.thinkingMode,
      permissions: this.state.permissionMode,
      autoCompactEnabled: this.state.autoCompactEnabled,
    });
  }

  private setCurrentModel(model: string) {
    this.store.setCurrentModel(model);
    if (!getSupportedThinkingModes(model).includes(this.state.thinkingMode))
      this.store.setThinkingMode('auto');
    this.store.resetLastUsage();
    this.persistPreferences();
    this.recordTurnContext();
    this.render();
  }

  private setThinkingMode(thinkingMode: AgentState['thinkingMode']) {
    this.store.setThinkingMode(thinkingMode);
    this.persistPreferences();
    this.recordTurnContext();
    this.render();
  }

  private setPermissionMode(permissionMode: PermissionMode) {
    this.store.setPermissionMode(permissionMode);
    this.persistPreferences();
    this.recordTurnContext();
    this.render();
  }

  private setPlanningMode(enabled: boolean) {
    this.store.setPlanningMode(enabled);
    this.store.resetLastUsage();
    this.recordTurnContext();
    this.render();
  }

  private setThreadTitle(
    title: string | null,
    source: ThreadNameSource = 'manual',
    expectedName?: string,
  ) {
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
        typeof tool === 'object' &&
        tool !== null &&
        'description' in tool &&
        typeof tool.description === 'string'
          ? tool.description.trim()
          : null;

      groups.set(tool, { names: [name], description });
    }

    return [...groups.values()].sort((a, b) => a.names[0].localeCompare(b.names[0]));
  }

  private getRuntimeMessages(
    messages: AgentMessage[] = this.state.messages,
    planningMode = this.state.planningMode,
  ): AgentMessage[] {
    const permissionPrompt =
      this.state.permissionMode === 'full'
        ? '<permissions mode="full">The user explicitly enabled Full Access. Tools run without the workspace sandbox or approval prompts.</permissions>'
        : `<permissions mode="${this.state.permissionMode}">Shell commands run in a network-denied workspace sandbox. Use permissions="elevated" with a justification when internet access or work outside the workspace is necessary.</permissions>`;
    const planningModePrompt = planningMode
      ? [
          '<session-mode name="planning">',
          '- Planning mode is enabled for this turn.',
          '- Focus on discovery, tradeoffs, and a concrete step-by-step plan.',
          '- Do not make file edits or run mutating commands.',
          '- Use shell only for read-only inspection and do not call apply_patch.',
          '- End with a concise recommendation and plan.',
          '</session-mode>',
        ].join('\n')
      : '';
    const runtimePrompt = [permissionPrompt, planningModePrompt].filter(Boolean).join('\n\n');

    const [first, ...rest] = messages;
    if (first?.role === 'system' && typeof first.content === 'string') {
      return [{ ...first, content: `${first.content}\n\n${runtimePrompt}` }, ...rest];
    }

    return [{ role: 'system' as const, content: runtimePrompt }, ...messages];
  }

  private cycleThinkingMode() {
    const next = cycleThinkingMode(this.state.thinkingMode, this.state.currentModel);
    this.store.setThinkingMode(next);
    this.persistPreferences();
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
    return (
      this.state.autoCompactEnabled &&
      this.state.lastPromptTokens >= getCompactionTriggerTokens(this.state.currentModel)
    );
  }

  private togglePreviewExpansion() {
    this.expandPreviews = !this.expandPreviews;
    this.resetRenderedScreen();
    this.showFooterNotice(this.expandPreviews ? 'Expanded previews' : 'Collapsed previews');
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

  private authorizeTool = async (
    request: ApprovalRequest,
    authorization: { requested: ToolPermission; potentiallyUnsafe?: boolean },
  ) => {
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

    const recommendedIndex = request.recommendedValue
      ? request.options.findIndex(option => option.value === request.recommendedValue)
      : -1;
    const selectedIndex = recommendedIndex >= 0 ? recommendedIndex : 0;

    const selection = await new Promise<ChoiceSelection | null>(resolve => {
      this.pendingChoiceResolver = resolve;
      this.store.setPendingChoice(request, selectedIndex);
      this.render();
    });

    if (!selection) throw new Error('choice cancelled by user');
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

  private persistCompactionNotice(text: string) {
    const lastEntry = this.state.historyEntries[this.state.historyEntries.length - 1];
    if (
      lastEntry?.type === 'entry' &&
      lastEntry.kind === EntryKind.Meta &&
      lastEntry.text === text
    ) {
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

  private async buildUserMessageContent(
    text: string,
  ): Promise<string | Array<AgentTextPart | AgentImagePart>> {
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
      const result = await this.tools.execute('shell', { command: cmd });
      const output = result.output.replace(/\n\nexit code: -?\d+$/, '');
      const exitCodeMatch = result.output.match(/\n\nexit code: (-?\d+)$/);
      const exitCode = exitCodeMatch ? Number(exitCodeMatch[1]) : 1;
      const trimmed = output.trimEnd();

      this.persistEntry(EntryKind.Shell, `${trimmedCommand} exit ${exitCode}`);
      if (trimmed) this.persistAnsi(trimmed);
      else if (exitCode === 0) this.persistPlain('(no output)');
    } catch (error: unknown) {
      this.persistEntry(
        EntryKind.Error,
        plain(error instanceof Error ? error.message : String(error)),
      );
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

  private async processSubmission(submission: string | QueuedSubmission) {
    const queuedSubmission = typeof submission === 'string' ? { text: submission } : submission;
    const raw = queuedSubmission.text;
    const trimmed = raw.trim();

    if (!trimmed) return;

    const planningModeOverride = queuedSubmission.planningMode;
    const previousPlanningMode =
      planningModeOverride === undefined ? undefined : this.state.planningMode;

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

      this.store.setBusyStatusText(`/${slashCommand.invocation}`);
      this.setBusy(true);
      this.render();

      try {
        await slashCommand.command.execute(
          {
            store: this.store,
            cleanup: code => this.cleanup(code),
            compactConversation: options => this.compactConversation(options),
            setCurrentModel: model => this.setCurrentModel(model),
            setThinkingMode: thinkingMode => this.setThinkingMode(thinkingMode),
            setPermissionMode: permissionMode => this.setPermissionMode(permissionMode),
            setPlanningMode: enabled => this.setPlanningMode(enabled),
            enqueueSubmission: (text, options) =>
              this.store.enqueueSubmission({ text, planningMode: options?.planningMode }),
            openCommandArgumentPicker: commandName => this.openCommandArgumentPicker(commandName),
            requestChoice: request => this.requestChoice(request),
            showFooterNotice: (text, durationMs) => this.showFooterNotice(text, durationMs),
            getActiveToolSummaries: () => this.getActiveToolSummaries(),
            getSessionId: () => this.sessionId,
            switchToSession: sessionId => this.switchToSession(sessionId),
            getLastRequestId: () => this.lastRequestId,
            getLastAssistantResponse: () => this.getLastAssistantResponse(),
            getThreadTitle: () => this.threadTitle,
            setThreadTitle: title => this.setThreadTitle(title),
            copyToClipboard: text => copyTextToClipboard(text),
            printEntries: entries => this.printEphemeralEntries(entries),
          },
          {
            raw: trimmed,
            invocation: slashCommand.invocation,
            argsText: slashCommand.argsText,
            argv: slashCommand.argv,
          },
        );
      } catch (error: unknown) {
        this.persistEntry(
          EntryKind.Error,
          plain(error instanceof Error ? error.message : String(error)),
        );
      } finally {
        this.setBusy(false);

        if (
          previousPlanningMode !== undefined &&
          this.state.planningMode !== previousPlanningMode
        ) {
          this.store.setPlanningMode(previousPlanningMode);
          this.store.resetLastUsage();
          this.recordTurnContext();
        }

        this.render();
        void this.drainQueuedSubmissions();
      }

      return;
    }

    if (trimmed.startsWith('!')) {
      await this.runShellCommand(trimmed.slice(1));
      return;
    }

    await this.promptHistory.add(trimmed, process.cwd());
    const displayedUserMessage = replaceTokensWithSummary(trimmed);
    this.startThreadTitleGeneration(displayedUserMessage);
    this.recordTurnContext();
    this.persistEntry(EntryKind.User, displayedUserMessage);

    const abortController = createAbortController(this.store);

    this.setBusy(true);
    this.store.clearLiveAssistantText();
    this.store.clearLiveReasoningText();
    this.store.resetLiveUsage();
    this.render();

    try {
      if (this.shouldAutoCompact()) await this.compactConversation();

      const userContent = await this.buildUserMessageContent(trimmed);
      const userMessage = { role: 'user' as const, content: userContent };
      this.store.pushMessage(userMessage);
      this.recordSessionEvent({ type: 'user_message', payload: { messages: [userMessage] } });

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

      syncLiveUsage();
      this.render();

      const result = await runAgentLoop({
        model: this.state.currentModel,
        thinkingMode: this.state.thinkingMode,
        messages: runtimeMessages,
        tools: this.getActiveTools(),
        maxSteps: 20,
        signal: abortController.signal,
        onEvent: async event => {
          if (abortController.signal.aborted || this.state.abortRequested) return;

          switch (event.type) {
            case 'reasoning-delta':
              currentStepReasoningText += event.text;
              this.store.appendLiveReasoningText(event.text);
              syncLiveUsage();
              this.scheduleRender();
              break;
            case 'text-delta':
              currentStepOutputText += event.text;
              this.store.appendLiveAssistantText(event.text);
              syncLiveUsage();
              this.scheduleRender();
              break;
            case 'step-completed':
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
              const part = {
                toolCallId: event.call.id,
                toolName: event.call.name,
                input: event.call.input,
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
                fileChanges: event.result.fileChanges,
              };
              const entry = createCompletedToolEntry(part);
              this.store.upsertToolEntry(entry);
              this.recordSessionEvent({
                type: 'tool_result',
                payload: { entry, message: event.message },
              });
              if (event.result.fileChanges?.length)
                await this.refreshSessionFileChanges(
                  event.result.fileChanges.map(fileChange => fileChange.path),
                );
              this.scheduleRender();
              break;
            }
            case 'tool-error': {
              const entry = createFailedToolEntry({
                toolCallId: event.call.id,
                toolName: event.call.name,
                input: event.call.input,
                error: event.error,
              });
              this.store.upsertToolEntry(entry);
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
      if (abortController.signal.aborted) {
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
            text: this.state.steerRequested ? '(steered)' : '(aborted)',
          },
        ]);
      } else {
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
      void this.drainQueuedSubmissions();
    }
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

  private requestSteer() {
    const controller = this.state.abortController;
    if (
      !this.state.busy ||
      !controller ||
      this.state.queuedSubmissions.length === 0 ||
      this.state.steerRequested
    )
      return false;

    this.store.setSteerRequested(true);
    this.store.setAbortRequested(true);
    controller.abort();
    this.render();
    return true;
  }

  private async submit() {
    const raw = this.state.inputChars.join('');
    const trimmed = raw.trim();

    if (!trimmed) {
      if (this.requestSteer()) return;
      return;
    }

    this.clearHistoryNavigation();
    this.resetPreferredComposerColumn();
    this.store.resetComposer();
    this.store.resetSelectedSuggestion();
    this.render();

    if (
      this.state.busy ||
      this.state.queuedSubmissions.length > 0 ||
      this.drainingQueuedSubmissions
    ) {
      this.store.enqueueSubmission({ text: raw });
      this.render();
      void this.drainQueuedSubmissions();
      return;
    }

    await this.processSubmission(raw);
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
          this.showFooterNotice(
            `couldn't attach ${file.absolutePath}: ${error instanceof Error ? error.message : 'error'}`,
          );
        }
      }
      if (tokens.length === 0) return;
      this.historyNavigationIndex = null;
      this.resetPreferredComposerColumn();
      this.store.insertText(tokens.join(' '));
      this.showFooterNotice(
        `attached ${summaries.length === 1 ? summaries[0] : `${summaries.length} images`}`,
      );
      this.render();
    })();
    return true;
  }

  private moveSuggestionSelection(delta: number) {
    const suggestions = this.getSuggestions();
    if (suggestions.length === 0) return false;

    this.resetPreferredComposerColumn();
    this.store.setSelectedSuggestion(
      (this.state.selectedSuggestion + delta + suggestions.length) % suggestions.length,
    );
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
      this.state.busy ||
      this.state.queuedSubmissions.length > 0 ||
      this.drainingQueuedSubmissions
    ) {
      this.store.enqueueSubmission({ text: raw });
      this.render();
      void this.drainQueuedSubmissions();
      return true;
    }

    await this.processSubmission(raw);
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
    if (binding.type === 'submit')
      return this.resolvePendingChoice(this.getSelectedPendingChoice());
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
    if (this.state.exitConfirmationPending) {
      this.store.setExitConfirmationPending(false);
      this.render();
      return;
    }

    if (handleAbortKeypress(this.store)) {
      this.render();
      return;
    }

    if (this.state.inputChars.length === 0 && this.state.selectedSuggestion === 0) return;
    this.clearHistoryNavigation();
    this.resetPreferredComposerColumn();
    this.store.resetComposer();
    this.store.resetSelectedSuggestion();
    this.render();
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

    if (binding.type === 'interrupt') {
      if (!this.shouldConfirmExit()) {
        this.cleanup(0);
        return;
      }

      if (!this.state.exitConfirmationPending) {
        this.store.setExitConfirmationPending(true);
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

    if (this.state.exitConfirmationPending) this.store.setExitConfirmationPending(false);

    if (this.state.abortConfirmationPending) {
      this.store.setAbortConfirmationPending(false);
      this.render();
    }

    if (binding.type === 'toggleThinkingMode') {
      this.cycleThinkingMode();
      return;
    }

    if (binding.type === 'togglePreviews') {
      this.togglePreviewExpansion();
      return;
    }

    if (binding.type === 'acceptSuggestion') {
      this.tryAcceptSuggestion();
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
      case 'backspace':
        this.handleDelete(true);
        return;
      case 'delete':
        this.handleDelete(false);
        return;
      case 'moveCursor':
        this.resetPreferredComposerColumn();
        this.store.setCursor(this.state.cursor + binding.delta);
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

  private onInputBinding = async (chunk: Buffer | string) => {
    await this.handleInputBinding(resolveInputBinding(chunk));
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

  private onStdinData = (chunk: Buffer | string) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    this.stdinBuffer += text;

    void (async () => {
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

        if (complete) await this.processNonPasteInput(complete);
        return;
      }
    })();
  };
}
