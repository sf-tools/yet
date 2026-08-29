import { addUsage, type AgentChatMessage, type AgentMessage } from './messages';
import { BackgroundTerminalManager } from './background-terminals';
import { runAgentLoop } from './runner';
import {
  createTurnContextEvent,
  hydrateStateFromSession,
  loadYetSession,
  persistedStateFromAgentState,
  SessionRecorder,
} from './session-storage';
import { createCompletedToolEntry, createFailedToolEntry, createPendingToolEntry } from './tool-history';
import { subagentInstructions } from './collaboration/role-instructions';
import type { AgentControl } from './collaboration/control';
import type { RegisteredAgent, AgentRuntimeHandle } from './collaboration/registry';
import { createAgentStore, createInitialState, type AgentState, type AgentStore } from '@/store';
import { createToolRegistry, type ToolAuthorization, type ToolRegistry } from '@/tools';
import { EntryKind, type ApprovalRequest, type HistoryEntry, type ThreadGoal } from '@/types';

export type AgentRuntimeOptions = {
  agent: RegisteredAgent;
  inheritedMessages: AgentMessage[];
  inheritedHistory: HistoryEntry[];
  control: AgentControl;
  authorize: (request: ApprovalRequest, authorization: ToolAuthorization) => Promise<boolean>;
  onChanged?: () => void;
};

function collaborationSystemMessage(path: string): AgentChatMessage {
  return { role: 'system', content: subagentInstructions(path) };
}

function withSubagentInstructions(messages: AgentMessage[], path: string) {
  const filtered = messages.filter(message =>
    message.role !== 'system' ||
    typeof message.content !== 'string' ||
    !message.content.includes('the primary agent in a team of agents'),
  );
  if (!filtered.some(message =>
    message.role === 'system' &&
    typeof message.content === 'string' &&
    message.content.includes(`canonical task name is \`${path}\``),
  )) filtered.push(collaborationSystemMessage(path));
  return filtered;
}

function cloneStateForChild(options: AgentRuntimeOptions) {
  const state = createInitialState();
  state.messages = withSubagentInstructions(options.inheritedMessages, options.agent.path);
  state.historyEntries = structuredClone(options.inheritedHistory);
  state.currentModel = options.agent.config.model;
  state.thinkingMode = options.agent.config.thinkingMode;
  state.fastModeEnabled = options.agent.config.fastModeEnabled;
  state.permissionMode = options.agent.config.permissionMode;
  state.planningMode = options.agent.config.planningMode;
  state.showThinking = false;
  return state;
}

export class AgentRuntime implements AgentRuntimeHandle {
  readonly store: AgentStore;
  readonly agent: RegisteredAgent;
  private readonly control: AgentControl;
  private readonly authorize: AgentRuntimeOptions['authorize'];
  private readonly onChanged?: () => void;
  private readonly terminals: BackgroundTerminalManager;
  private readonly tools: ToolRegistry;
  private recorder: SessionRecorder | null = null;
  private activeTask: Promise<void> | null = null;
  private disposed = false;

  private constructor(options: AgentRuntimeOptions, state: AgentState) {
    this.agent = options.agent;
    this.control = options.control;
    this.authorize = options.authorize;
    this.onChanged = options.onChanged;
    this.store = createAgentStore(state);
    this.terminals = new BackgroundTerminalManager(() => this.changed());
    this.tools = createToolRegistry({
      workspaceRoot: options.agent.config.cwd,
      execCommand: (command, execOptions) => this.terminals.exec(command, execOptions),
      writeStdin: (sessionId, chars, writeOptions) =>
        this.terminals.write(sessionId, chars, writeOptions),
      authorize: (request, authorization) => this.authorize(request, authorization),
      getPermissionMode: () => this.store.getState().permissionMode,
      getPlanningMode: () => this.store.getState().planningMode,
      getThinkingMode: () => this.store.getState().thinkingMode,
      recordFileMutations: () => {},
      getGoal: () => this.store.getState().goal,
      createGoal: (objective, tokenBudget) => this.createGoal(objective, tokenBudget),
      updateGoal: status => this.updateGoal(status),
      collaboration: {
        agentId: options.agent.id,
        agentPath: options.agent.path,
        control: options.control,
      },
    });
  }

  static async create(options: AgentRuntimeOptions) {
    const loaded = await loadYetSession(options.agent.id);
    const state = loaded ? hydrateStateFromSession(loaded) : cloneStateForChild(options);
    state.messages = withSubagentInstructions(state.messages, options.agent.path);
    const runtime = new AgentRuntime(options, state);
    runtime.recorder = await SessionRecorder.open({
      sessionId: options.agent.id,
      cwd: options.agent.config.cwd,
      rolloutPath: loaded?.rolloutPath ?? options.agent.sessionRolloutPath,
      createdAt: loaded?.createdAt ?? options.agent.createdAt,
      parentSessionId: options.agent.parentId ?? undefined,
      rootSessionId: options.agent.rootId,
      agentPath: options.agent.path,
      agentForkMode: 'collaboration',
      agentConfig: options.agent.config,
    });
    options.agent.sessionRolloutPath = runtime.recorder.rolloutPath;
    if (!loaded) {
      runtime.recorder.record({
        type: 'fork_snapshot',
        payload: { state: persistedStateFromAgentState(state, true) },
      });
      runtime.recorder.record(createTurnContextEvent(state));
    }
    return runtime;
  }

  isBusy() {
    return this.activeTask !== null;
  }

  getState() {
    return this.store.getState();
  }

  getHistoryRevision() {
    return this.store.getHistoryRevision();
  }

  updateConfiguration(config: RegisteredAgent['config']) {
    this.store.update(state => {
      state.currentModel = config.model;
      state.thinkingMode = config.thinkingMode;
      state.fastModeEnabled = config.fastModeEnabled;
      state.permissionMode = config.permissionMode;
      state.planningMode = config.planningMode;
    });
  }

  recordCollaborationActivity(entry: HistoryEntry) {
    this.store.pushHistoryEntry(entry);
    this.record({ type: 'transcript_entry', payload: { entries: [entry] } });
    this.changed();
  }

  async start(fallbackMessage?: string) {
    if (this.disposed) throw new Error(`agent ${this.agent.path} is unloaded`);
    if (this.activeTask) return;
    const mailboxMessages = this.control.mailboxMessages(this.agent.id);
    const messages = mailboxMessages.length > 0
      ? mailboxMessages
      : fallbackMessage
        ? [{ role: 'user' as const, content: fallbackMessage }]
        : [];
    if (messages.length === 0) return;

    const release = this.control.acquireExecution(this.agent.id);
    this.control.updateStatus(this.agent.id, 'running');
    this.activeTask = this.runTurn(messages)
      .finally(() => {
        release();
        this.activeTask = null;
        this.changed();
        if (!this.disposed && this.agent.mailbox.pending().some(envelope => envelope.triggerTurn)) {
          queueMicrotask(() => void this.start().catch(() => {}));
        }
      });
  }

  async interrupt() {
    this.store.getState().abortController?.abort(new DOMException('Interrupted', 'AbortError'));
    await this.activeTask?.catch(() => {});
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    await this.interrupt();
    this.terminals.stopAll();
    await this.recorder?.close();
    this.recorder = null;
  }

  private async runTurn(inputMessages: AgentChatMessage[]) {
    const state = this.store.getState();
    const abortController = new AbortController();
    state.abortController = abortController;
    state.busy = true;
    state.liveAssistantText = '';
    state.liveReasoningText = '';
    const userEntries = inputMessages.map(message => ({
      type: 'entry' as const,
      kind: EntryKind.User,
      text: typeof message.content === 'string' ? message.content : '[attachment]',
    }));
    this.store.pushMessages(inputMessages);
    for (const entry of userEntries) this.store.pushHistoryEntry(entry);
    this.record({ type: 'user_message', payload: { messages: inputMessages, entries: userEntries } });
    this.record(createTurnContextEvent(state));
    const sessionUsageAtStart = { ...state.sessionUsage };

    try {
      const result = await runAgentLoop({
        model: state.currentModel,
        thinkingMode: state.thinkingMode,
        fastModeEnabled: state.fastModeEnabled,
        messages: [...state.messages],
        tools: this.tools,
        signal: abortController.signal,
        takeSteers: () => Promise.resolve(this.control.mailboxMessages(this.agent.id)),
        onEvent: async event => {
          switch (event.type) {
            case 'text-delta':
              this.store.appendLiveAssistantText(event.text);
              break;
            case 'reasoning-delta':
              this.store.appendLiveReasoningText(event.text);
              break;
            case 'tool-call': {
              const entry = createPendingToolEntry({
                toolCallId: event.call.id,
                toolName: event.call.namespace
                  ? `${event.call.namespace}.${event.call.name}`
                  : event.call.name,
                input: event.call.input,
              });
              this.store.upsertToolEntry(entry);
              this.record({ type: 'tool_call', payload: { entry, message: event.message } });
              break;
            }
            case 'tool-result': {
              const entry = createCompletedToolEntry({
                toolCallId: event.call.id,
                toolName: event.call.namespace
                  ? `${event.call.namespace}.${event.call.name}`
                  : event.call.name,
                input: event.call.input,
                output: event.result.output,
                fileChanges: event.result.fileChanges,
              });
              this.store.upsertToolEntry(entry);
              this.record({ type: 'tool_result', payload: { entry, message: event.message } });
              break;
            }
            case 'tool-error': {
              const entry = createFailedToolEntry({
                toolCallId: event.call.id,
                toolName: event.call.namespace
                  ? `${event.call.namespace}.${event.call.name}`
                  : event.call.name,
                input: event.call.input,
                error: event.error,
              });
              this.store.upsertToolEntry(entry);
              this.record({ type: 'tool_result', payload: { entry, message: event.message } });
              break;
            }
            case 'step-completed':
              if (event.message) {
                this.record({ type: 'assistant_message', payload: { messages: [event.message] } });
              }
              break;
          }
          this.changed();
        },
      });

      abortController.signal.throwIfAborted();
      this.store.pushMessages(result.messages);
      const reasoning = state.liveReasoningText.trim();
      const assistant = state.liveAssistantText.trim() || result.text.trim();
      const entries: HistoryEntry[] = [
        ...(reasoning ? [{ type: 'entry' as const, kind: EntryKind.Reasoning, text: reasoning }] : []),
        ...(assistant ? [{ type: 'entry' as const, kind: EntryKind.Assistant, text: assistant }] : []),
      ];
      for (const entry of entries) this.store.pushHistoryEntry(entry);
      state.sessionUsage = addUsage(sessionUsageAtStart, result.usage);
      state.lastPromptTokens = result.usage.inputTokens;
      state.lastOutputTokens = result.usage.outputTokens;
      state.lastReasoningTokens = result.usage.reasoningTokens;
      this.control.addUsage(this.agent.id, result.usage);
      this.record({ type: 'assistant_message', payload: { entries } });
      this.record({
        type: 'usage_updated',
        payload: {
          lastUsage: result.usage,
          sessionUsage: state.sessionUsage,
          totalCost: state.totalCost,
        },
      });
      await this.recorder?.flush();
      this.control.updateStatus(this.agent.id, { completed: assistant || null });
    } catch (error) {
      if (abortController.signal.aborted) {
        this.control.updateStatus(this.agent.id, 'interrupted');
      } else {
        const message = error instanceof Error ? error.message : String(error);
        this.store.pushHistoryEntry({ type: 'entry', kind: EntryKind.Error, text: message });
        this.record({
          type: 'transcript_entry',
          payload: { entries: [{ type: 'entry', kind: EntryKind.Error, text: message }] },
        });
        this.control.updateStatus(this.agent.id, { errored: message });
      }
    } finally {
      state.busy = false;
      state.abortController = null;
      state.liveAssistantText = '';
      state.liveReasoningText = '';
      await this.recorder?.flush().catch(() => {});
      this.changed();
    }
  }

  private createGoal(objective: string, tokenBudget?: number): ThreadGoal {
    const now = Date.now();
    const goal: ThreadGoal = {
      objective,
      status: 'active',
      ...(tokenBudget ? { tokenBudget } : {}),
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.store.setGoal(goal);
    return goal;
  }

  private updateGoal(status: 'complete' | 'blocked') {
    const current = this.store.getState().goal;
    if (!current) throw new Error('no active goal');
    const goal = { ...current, status, updatedAt: Date.now() };
    this.store.setGoal(goal);
    return goal;
  }

  private record(event: Parameters<SessionRecorder['record']>[0]) {
    this.recorder?.record(event);
  }

  private changed() {
    this.agent.updatedAt = new Date().toISOString();
    this.onChanged?.();
  }
}
