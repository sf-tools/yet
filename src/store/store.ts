import { createInitialState } from './state';
import { imageTokenRangeAt } from '@/agent/image-tokens';

import type { AgentMessage, AgentUsage } from '@/agent/messages';
import type {
  ApprovalRequest,
  ChoiceRequest,
  FileChange,
  HistoryEntry,
} from '@/types';
import type { AgentState, QueuedSubmission } from './types';

export type AgentStore = ReturnType<typeof buildAgentStore>;

function hasVisibleContent(entry: HistoryEntry) {
  if (
    entry.type === 'tool' ||
    entry.type === 'compacted' ||
    entry.type === 'forked' ||
    entry.type === 'resume_hint' ||
    entry.type === 'background_processes'
    || entry.type === 'collaboration'
    || entry.type === 'separator'
    || entry.type === 'goal_summary'
  ) return true;
  if (entry.type === 'plain' || entry.type === 'ansi') return entry.text.trim().length > 0;
  return entry.text.trim().length > 0;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, max));
}

function sortPasteRanges(state: AgentState) {
  state.pasteRanges.sort((left, right) => left.start - right.start || left.end - right.end);
}

function prunePasteRanges(state: AgentState) {
  for (let index = state.pasteRanges.length - 1; index >= 0; index -= 1) {
    const range = state.pasteRanges[index];
    const segment = state.inputChars.slice(range.start, range.end);

    if (range.end <= range.start || !segment.includes('\n')) state.pasteRanges.splice(index, 1);
  }
}

function shiftPasteRangesForInsert(state: AgentState, at: number, count: number) {
  for (const range of state.pasteRanges) {
    if (range.start >= at) {
      range.start += count;
      range.end += count;
      continue;
    }

    if (range.end > at) range.end += count;
  }
}

function shiftPasteRangesForDelete(state: AgentState, at: number) {
  for (const range of state.pasteRanges) {
    if (at < range.start) {
      range.start -= 1;
      range.end -= 1;
      continue;
    }

    if (at < range.end) range.end -= 1;
  }
}

function removePasteRange(state: AgentState, target: AgentState['pasteRanges'][number]) {
  const length = target.end - target.start;
  if (length <= 0) return false;

  state.inputChars.splice(target.start, length);
  state.pasteRanges = state.pasteRanges
    .filter(range => range !== target)
    .map(range => {
      if (range.start >= target.end) {
        return { start: range.start - length, end: range.end - length };
      }

      return range;
    });

  sortPasteRanges(state);
  prunePasteRanges(state);
  state.cursor = Math.min(state.cursor, state.inputChars.length);
  return true;
}

function buildAgentStore(initialState: AgentState) {
  const state = initialState;
  let historyRevision = 0;

  return {
    getState() {
      return state;
    },

    update(updater: (state: AgentState) => void) {
      updater(state);
      historyRevision += 1;
      return state;
    },

    getHistoryRevision() {
      return historyRevision;
    },

    setClosed(closed = true) {
      state.closed = closed;
      return state;
    },

    setBusy(busy: boolean) {
      state.busy = busy;
      if (!busy) {
        state.busyStatusText = null;
        state.backgroundWaitCommand = null;
      }
      return state;
    },

    setBusyStatusText(busyStatusText: string | null) {
      state.busyStatusText = busyStatusText;
      return state;
    },

    setBackgroundWaitCommand(backgroundWaitCommand: string | null) {
      state.backgroundWaitCommand = backgroundWaitCommand;
      return state;
    },

    resetComposer() {
      state.inputChars.length = 0;
      state.pasteRanges.length = 0;
      state.cursor = 0;
      return state;
    },

    setAbortController(abortController: AbortController | null) {
      state.abortController = abortController;
      if (abortController === null) {
        state.abortRequested = false;
        state.steerRequested = false;
      }
      return state;
    },

    setAbortRequested(abortRequested: boolean) {
      state.abortRequested = abortRequested;
      return state;
    },

    setSteerRequested(steerRequested: boolean) {
      state.steerRequested = steerRequested;
      return state;
    },

    setPendingApproval(pendingApproval: ApprovalRequest | null) {
      state.pendingApproval = pendingApproval;
      return state;
    },

    setPendingChoice(pendingChoice: ChoiceRequest | null, pendingChoiceIndex = 0) {
      state.pendingChoice = pendingChoice;
      state.pendingChoiceIndex = pendingChoice
        ? Math.max(0, Math.min(pendingChoiceIndex, pendingChoice.options.length - 1))
        : 0;
      return state;
    },

    setPendingChoiceIndex(pendingChoiceIndex: number) {
      if (!state.pendingChoice) {
        state.pendingChoiceIndex = 0;
        return state;
      }

      state.pendingChoiceIndex = clamp(
        pendingChoiceIndex,
        0,
        Math.max(0, state.pendingChoice.options.length - 1),
      );
      return state;
    },

    setPendingTextPrompt(pendingTextPrompt: AgentState['pendingTextPrompt']) {
      state.pendingTextPrompt = pendingTextPrompt;
      return state;
    },

    setConfigPicker(configPicker: AgentState['configPicker']) {
      state.configPicker = configPicker;
      return state;
    },

    setStatusPanel(statusPanel: AgentState['statusPanel']) {
      state.statusPanel = statusPanel;
      return state;
    },

    setSubagentsPicker(subagentsPicker: AgentState['subagentsPicker']) {
      state.subagentsPicker = subagentsPicker;
      return state;
    },

    setSubagentsPickerSelectedIndex(selectedIndex: number) {
      if (!state.subagentsPicker || state.subagentsPicker.items.length === 0) return state;
      state.subagentsPicker.selectedIndex = clamp(
        selectedIndex,
        0,
        state.subagentsPicker.items.length - 1,
      );
      return state;
    },

    setAgentsOverview(agentsOverview: AgentState['agentsOverview']) {
      state.agentsOverview = agentsOverview;
      return state;
    },

    setAgentsOverviewSelectedIndex(selectedIndex: number) {
      if (!state.agentsOverview) return state;
      state.agentsOverview.selectedIndex = Math.max(0, selectedIndex);
      return state;
    },

    setAgentsOverviewQuery(query: string) {
      if (!state.agentsOverview) return state;
      state.agentsOverview.query = query;
      state.agentsOverview.selectedIndex = 0;
      return state;
    },

    setAgentsOverviewInteraction(input: Partial<Pick<NonNullable<AgentState['agentsOverview']>, 'draft' | 'mode' | 'grouping'>>) {
      if (!state.agentsOverview) return state;
      Object.assign(state.agentsOverview, input);
      return state;
    },

    setConfigPickerSelectedIndex(selectedIndex: number) {
      if (!state.configPicker || state.configPicker.items.length === 0) return state;
      state.configPicker.selectedIndex = clamp(
        selectedIndex,
        0,
        state.configPicker.items.length - 1,
      );
      return state;
    },

    toggleSelectedConfigPickerItem() {
      const picker = state.configPicker;
      if (!picker) return false;
      const item = picker.items[picker.selectedIndex];
      if (!item) return false;
      item.enabled = !item.enabled;
      return true;
    },

    setFooterNotice(footerNotice: string | null) {
      state.footerNotice = footerNotice;
      return state;
    },

    upsertSessionFileChanges(fileChanges: FileChange[]) {
      const next = new Map(
        state.sessionFileChanges.map(fileChange => [fileChange.path, fileChange]),
      );

      for (const fileChange of fileChanges) {
        if (fileChange.hasChanges) next.set(fileChange.path, fileChange);
        else next.delete(fileChange.path);
      }

      state.sessionFileChanges = Array.from(next.values()).sort((left, right) =>
        left.path.localeCompare(right.path),
      );
      return state;
    },

    setPermissionMode(permissionMode: AgentState['permissionMode']) {
      state.permissionMode = permissionMode;
      return state;
    },

    setAutoCompactEnabled(autoCompactEnabled: boolean) {
      state.autoCompactEnabled = autoCompactEnabled;
      return state;
    },

    setPlanningMode(planningMode: boolean) {
      state.planningMode = planningMode;
      return state;
    },

    setShowThinking(showThinking: boolean) {
      state.showThinking = showThinking;
      return state;
    },

    setShowCommandSummaries(showCommandSummaries: boolean) {
      state.showCommandSummaries = showCommandSummaries;
      return state;
    },

    setCompacting(compacting: boolean) {
      state.compacting = compacting;
      return state;
    },

    setSideConversation(sideConversation: AgentState['sideConversation']) {
      state.sideConversation = sideConversation;
      return state;
    },

    setGoal(goal: AgentState['goal']) {
      state.goal = goal;
      return state;
    },

    setLiveAssistantText(text: string) {
      state.liveAssistantText = text;
      return state;
    },

    appendLiveAssistantText(chunk: string) {
      state.liveAssistantText += chunk;
      return state;
    },

    clearLiveAssistantText() {
      state.liveAssistantText = '';
      return state;
    },

    setLiveReasoningText(text: string) {
      state.liveReasoningText = text;
      return state;
    },

    setLiveUsage(usage: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number }) {
      state.livePromptTokens = usage.inputTokens ?? 0;
      state.liveOutputTokens = usage.outputTokens ?? 0;
      state.liveReasoningTokens = usage.reasoningTokens ?? 0;
      return state;
    },

    resetLiveUsage() {
      state.livePromptTokens = 0;
      state.liveOutputTokens = 0;
      state.liveReasoningTokens = 0;
      return state;
    },

    appendLiveReasoningText(chunk: string) {
      state.liveReasoningText += chunk;
      return state;
    },

    clearLiveReasoningText() {
      state.liveReasoningText = '';
      return state;
    },

    pushMessage(message: AgentMessage) {
      state.messages.push(message);
      return state;
    },

    pushMessages(messages: AgentMessage[]) {
      state.messages.push(...messages);
      return state;
    },

    replaceMessages(messages: AgentMessage[]) {
      state.messages.splice(0, state.messages.length, ...messages);
      return state;
    },

    pushHistoryEntry(entry: HistoryEntry) {
      if (hasVisibleContent(entry)) {
        state.historyEntries.push(entry);
        historyRevision += 1;
      }
      return state;
    },

    updateLastHistoryEntry(updater: (entry: HistoryEntry) => HistoryEntry | null) {
      const index = state.historyEntries.length - 1;
      if (index < 0) return state;

      const nextEntry = updater(state.historyEntries[index]);
      if (nextEntry) {
        state.historyEntries[index] = nextEntry;
        historyRevision += 1;
      }
      return state;
    },

    enqueueSubmission(submission: QueuedSubmission) {
      state.queuedSubmissions.push(submission);
      return state;
    },

    shiftQueuedSubmission() {
      return state.queuedSubmissions.shift();
    },

    popQueuedSubmission() {
      return state.queuedSubmissions.pop();
    },

    takeQueuedSubmissions() {
      return state.queuedSubmissions.splice(0);
    },

    enqueuePendingSteer(submission: QueuedSubmission) {
      state.pendingSteers.push(submission);
      return state;
    },

    takePendingSteers(count = state.pendingSteers.length) {
      return state.pendingSteers.splice(0, Math.max(0, count));
    },

    upsertToolEntry(entry: Extract<HistoryEntry, { type: 'tool' }>) {
      const index = state.historyEntries.findIndex(
        candidate => candidate.type === 'tool' && candidate.toolCallId === entry.toolCallId,
      );

      if (index === -1) state.historyEntries.push(entry);
      else state.historyEntries[index] = entry;
      historyRevision += 1;

      return state;
    },

    setSelectedSuggestion(selectedSuggestion: number) {
      state.selectedSuggestion = selectedSuggestion;
      return state;
    },

    resetSelectedSuggestion() {
      state.selectedSuggestion = 0;
      return state;
    },

    replaceState(nextState: AgentState) {
      Object.assign(state, nextState);
      historyRevision += 1;
      return state;
    },

    setCurrentModel(currentModel: string) {
      state.currentModel = currentModel;
      return state;
    },

    setThinkingMode(thinkingMode: AgentState['thinkingMode']) {
      state.thinkingMode = thinkingMode;
      return state;
    },

    setFastModeEnabled(fastModeEnabled: boolean) {
      state.fastModeEnabled = fastModeEnabled;
      return state;
    },

    setLastUsage(usage: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number }) {
      state.lastPromptTokens = usage.inputTokens ?? 0;
      state.lastOutputTokens = usage.outputTokens ?? 0;
      state.lastReasoningTokens = usage.reasoningTokens ?? 0;
      return state;
    },

    resetLastUsage() {
      state.lastPromptTokens = 0;
      state.lastOutputTokens = 0;
      state.lastReasoningTokens = 0;
      state.livePromptTokens = 0;
      state.liveOutputTokens = 0;
      state.liveReasoningTokens = 0;
      return state;
    },

    setSessionUsage(usage: AgentUsage) {
      state.sessionUsage = { ...usage };
      return state;
    },

    addTotalCost(cost: number) {
      state.totalCost += cost;
      return state;
    },

    setCursor(cursor: number) {
      state.cursor = clamp(cursor, 0, state.inputChars.length);
      return state;
    },

    moveCursor(delta: number) {
      if (delta === 0) return state;

      const direction = delta < 0 ? 'backward' : 'forward';
      const imageRange = imageTokenRangeAt(state.inputChars, state.cursor, direction);
      if (imageRange) {
        state.cursor = direction === 'backward' ? imageRange.start : imageRange.end;
        return state;
      }

      state.cursor = clamp(state.cursor + delta, 0, state.inputChars.length);
      return state;
    },

    replaceInput(text: string, cursor = text.length) {
      state.inputChars.splice(0, state.inputChars.length, ...Array.from(text));
      state.pasteRanges.length = 0;
      state.cursor = clamp(cursor, 0, state.inputChars.length);
      return state;
    },

    prependInput(text: string) {
      const chars = Array.from(text);
      if (chars.length === 0) return state;

      state.inputChars.unshift(...chars);
      for (const range of state.pasteRanges) {
        range.start += chars.length;
        range.end += chars.length;
      }
      state.cursor += chars.length;
      return state;
    },

    insertText(text: string) {
      const chars = Array.from(text);
      const start = state.cursor;

      shiftPasteRangesForInsert(state, start, chars.length);
      state.inputChars.splice(start, 0, ...chars);
      prunePasteRanges(state);
      state.cursor += chars.length;
      return state;
    },

    insertPastedText(text: string) {
      const chars = Array.from(text);
      const start = state.cursor;
      const existingRange = state.pasteRanges.find(
        range => start > range.start && start < range.end,
      );

      shiftPasteRangesForInsert(state, start, chars.length);
      state.inputChars.splice(start, 0, ...chars);

      if (text.includes('\n') && !existingRange) {
        state.pasteRanges.push({ start, end: start + chars.length });
        sortPasteRanges(state);
      }

      prunePasteRanges(state);
      state.cursor += chars.length;
      return state;
    },

    deleteBackward() {
      if (state.cursor <= 0) return false;

      const pasteRange = state.pasteRanges.find(
        range => state.cursor > range.start && state.cursor <= range.end,
      );
      if (pasteRange) {
        state.cursor = pasteRange.start;
        return removePasteRange(state, pasteRange);
      }

      const imageRange = imageTokenRangeAt(state.inputChars, state.cursor, 'backward');
      if (imageRange) {
        const length = imageRange.end - imageRange.start;
        for (let index = 0; index < length; index += 1) {
          shiftPasteRangesForDelete(state, imageRange.start);
        }
        state.inputChars.splice(imageRange.start, length);
        prunePasteRanges(state);
        state.cursor = imageRange.start;
        return true;
      }

      state.inputChars.splice(state.cursor - 1, 1);
      shiftPasteRangesForDelete(state, state.cursor - 1);
      prunePasteRanges(state);
      state.cursor -= 1;
      return true;
    },

    deleteForward() {
      if (state.cursor >= state.inputChars.length) return false;

      const pasteRange = state.pasteRanges.find(
        range => state.cursor >= range.start && state.cursor < range.end,
      );
      if (pasteRange) {
        state.cursor = pasteRange.start;
        return removePasteRange(state, pasteRange);
      }

      const imageRange = imageTokenRangeAt(state.inputChars, state.cursor, 'forward');
      if (imageRange) {
        const length = imageRange.end - imageRange.start;
        for (let index = 0; index < length; index += 1) {
          shiftPasteRangesForDelete(state, imageRange.start);
        }
        state.inputChars.splice(imageRange.start, length);
        prunePasteRanges(state);
        state.cursor = imageRange.start;
        return true;
      }

      state.inputChars.splice(state.cursor, 1);
      shiftPasteRangesForDelete(state, state.cursor);
      prunePasteRanges(state);
      return true;
    },
  };
}

export function createAgentStore(initialState: AgentState = createInitialState()): AgentStore {
  return buildAgentStore(initialState);
}
