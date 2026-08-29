import { randomUUID } from 'node:crypto';

import type { AgentMessage } from '@/agent/messages';
import type { AgentState } from '@/store';
import { getSupportedThinkingModes, isSupportedOpenAIModel, type ThinkingMode } from '@/config';
import { addUsage, type AgentUsage } from '@/agent/messages';
import {
  agentPathMatchesPrefix,
  childAgentPath,
  normalizeAgentPath,
  resolveAgentPath,
  ROOT_AGENT_PATH,
} from './agent-path';
import { AgentExecutionLimiter } from './execution-limiter';
import { forkAgentMessages, parseForkTurns, validateSpawnOverrides, type ForkTurns } from './fork-history';
import { formatMailboxEnvelope, type MailboxEnvelope } from './mailbox';
import {
  AgentRegistry,
  type AgentConfigurationSnapshot,
  type AgentRuntimeHandle,
  type PersistedRegisteredAgent,
  type RegisteredAgent,
} from './registry';
import { AgentResidency } from './residency';
import { cloneAgentStatus, isFinalAgentStatus, type AgentStatus } from './status';

export type CollaborationActivity = {
  id: string;
  kind: 'spawned' | 'interacted' | 'waiting' | 'interrupted' | 'completed';
  actorPath: string;
  targetPath?: string;
  message?: string;
  timestamp: string;
};

export type SpawnAgentRequest = {
  taskName: string;
  message: string;
  forkTurns?: unknown;
  model?: string;
  reasoningEffort?: string;
};

export type AgentRuntimeFactoryInput = {
  agent: RegisteredAgent;
  inheritedMessages: AgentMessage[];
  inheritedHistory: AgentState['historyEntries'];
  control: AgentControl;
};

export type AgentControlOptions = {
  maxConcurrency?: number;
  maxResidents?: number;
  runtimeFactory: (input: AgentRuntimeFactoryInput) => Promise<AgentRuntimeHandle>;
  onActivity?: (activity: CollaborationActivity) => void;
  onChanged?: () => void;
  persist?: (event: AgentGraphEvent) => void | Promise<void>;
};

export type AgentGraphEvent =
  | { type: 'agent_upsert'; agent: PersistedRegisteredAgent }
  | { type: 'mailbox_dequeued'; agentId: string; envelopeIds: string[] }
  | { type: 'agent_removed'; agentId: string };

export class AgentControl {
  readonly registry = new AgentRegistry();
  readonly maxConcurrency: number;
  private readonly execution: AgentExecutionLimiter;
  private readonly residency: AgentResidency;
  private readonly runtimeFactory: AgentControlOptions['runtimeFactory'];
  private readonly onActivity?: AgentControlOptions['onActivity'];
  private readonly onChanged?: AgentControlOptions['onChanged'];
  private readonly persist?: AgentControlOptions['persist'];

  constructor(options: AgentControlOptions) {
    this.maxConcurrency = Math.max(1, options.maxConcurrency ?? 4);
    this.execution = new AgentExecutionLimiter(Math.max(0, this.maxConcurrency - 1));
    this.residency = new AgentResidency(
      Math.max(0, Math.min(options.maxResidents ?? this.maxConcurrency, this.maxConcurrency) - 1),
    );
    this.runtimeFactory = options.runtimeFactory;
    this.onActivity = options.onActivity;
    this.onChanged = options.onChanged;
    this.persist = options.persist;
  }

  registerRoot(input: {
    id: string;
    config: AgentConfigurationSnapshot;
    runtime: AgentRuntimeHandle;
    createdAt?: string;
  }) {
    const agent = this.registry.registerRoot(input);
    this.changed(agent);
    return agent;
  }

  restoreAgent(agent: PersistedRegisteredAgent) {
    const restored = this.registry.restore(agent);
    if (restored.path !== ROOT_AGENT_PATH && (restored.status === 'running' || restored.status === 'pending_init')) {
      restored.status = 'interrupted';
      this.changed(restored);
    }
    if (restored.path === ROOT_AGENT_PATH) this.changed(restored);
    this.onChanged?.();
    return restored;
  }

  async spawnAgent(callerId: string, request: SpawnAgentRequest) {
    const caller = this.requireAgent(callerId);
    if (!request.message.trim()) throw new Error("Empty message can't be sent to an agent");
    const forkTurns = parseForkTurns(request.forkTurns);
    validateSpawnOverrides({
      forkTurns,
      model: request.model,
      reasoningEffort: request.reasoningEffort,
    });
    const path = childAgentPath(caller.path, request.taskName);
    const config = this.childConfiguration(caller.config, forkTurns, request);
    const reservation = this.registry.reserve(path);
    let child: RegisteredAgent | null = null;
    try {
      const state = caller.runtime?.getState();
      const inheritedMessages = forkAgentMessages(state?.messages ?? [], forkTurns);
      const inheritedHistory = this.forkHistoryEntries(state?.historyEntries ?? [], forkTurns);
      child = reservation.commit({
        rootId: caller.rootId,
        parentId: caller.id,
        taskName: request.taskName,
        nickname: null,
        status: 'pending_init',
        config,
        runtime: null,
      });
      await this.residency.reserve({
        protectedAgentId: caller.id,
        canUnload: id => this.canUnload(id),
        unload: id => this.unloadAgent(id),
      });
      // Runtime factories need the committed identity. Kept separate from reservation so path
      // uniqueness remains atomic if construction fails.
      child.runtime = await this.runtimeFactory({
        agent: child,
        inheritedMessages,
        inheritedHistory,
        control: this,
      });
      this.residency.touch(child.id);
      const envelope = child.mailbox.enqueue({
        kind: 'NEW_TASK',
        from: caller.path,
        to: child.path,
        message: request.message,
        triggerTurn: true,
      });
      this.changed(child);
      this.activity('spawned', caller.path, child.path, request.message);
      await child.runtime.start(formatMailboxEnvelope(envelope));
      return { task_name: child.path, nickname: child.nickname };
    } catch (error) {
      reservation.release();
      if (child) {
        await child.runtime?.dispose().catch(() => {});
        this.registry.remove(child.id);
        this.residency.remove(child.id);
        void this.persist?.({ type: 'agent_removed', agentId: child.id });
      }
      throw error;
    }
  }

  async sendMessage(
    callerId: string,
    target: string,
    message: string,
    options: { triggerTurn: boolean },
  ) {
    if (!message.trim()) throw new Error("Empty message can't be sent to an agent");
    const caller = this.requireAgent(callerId);
    const receiver = this.resolveTarget(caller, target);
    if (options.triggerTurn && receiver.path === ROOT_AGENT_PATH) {
      throw new Error("Follow-up tasks can't target the root agent");
    }
    await this.ensureLoaded(receiver, caller.id);
    const envelope = receiver.mailbox.enqueue({
      kind: 'MESSAGE',
      from: caller.path,
      to: receiver.path,
      message,
      triggerTurn: options.triggerTurn,
    });
    this.changed(receiver);
    this.activity('interacted', caller.path, receiver.path, message);
    if (options.triggerTurn && !receiver.runtime?.isBusy()) {
      try {
        await receiver.runtime?.start(formatMailboxEnvelope(envelope));
      } catch (error) {
        receiver.mailbox.remove(envelope.id);
        this.changed(receiver);
        throw error;
      }
    }
  }

  listAgents(callerId: string, pathPrefix?: string) {
    const caller = this.requireAgent(callerId);
    const prefix = pathPrefix ? resolveAgentPath(caller.path, pathPrefix) : ROOT_AGENT_PATH;
    return this.registry.all()
      .filter(agent => agent.rootId === caller.rootId && agentPathMatchesPrefix(agent.path, prefix))
      .filter(agent => agent.status !== 'shutdown')
      .map(agent => ({
        agent_name: agent.path,
        agent_status: cloneAgentStatus(agent.status),
      }));
  }

  navigationAgents(rootId: string) {
    return this.registry.all()
      .filter(agent => agent.rootId === rootId)
      .map(agent => ({
        id: agent.id,
        path: agent.path,
        nickname: agent.nickname,
        status: cloneAgentStatus(agent.status),
        spawnOrder: agent.spawnOrder,
      }));
  }

  async activateAgent(agentId: string, protectedAgentId?: string) {
    const agent = this.requireAgent(agentId);
    await this.ensureLoaded(agent, protectedAgentId);
    return agent;
  }

  async waitAgent(callerId: string, requestedTimeoutMs?: number, signal?: AbortSignal) {
    const caller = this.requireAgent(callerId);
    const minTimeout = 10_000;
    const maxTimeout = 3_600_000;
    if (requestedTimeoutMs !== undefined && requestedTimeoutMs > maxTimeout) {
      throw new Error(`timeout_ms must be at most ${maxTimeout}`);
    }
    const timeoutMs = Math.max(minTimeout, requestedTimeoutMs ?? 30_000);
    this.activity('waiting', caller.path);
    const updates = await caller.mailbox.wait(timeoutMs, signal);
    const timedOut = updates === null;
    let message = timedOut
      ? 'Wait timed out.'
      : updates.length === 0
        ? 'Wait interrupted by new input.'
        : 'Wait completed.';
    if (requestedTimeoutMs !== undefined && requestedTimeoutMs < minTimeout) {
      message += `\n\nRequested timeout of ${requestedTimeoutMs}ms was clamped to the minimum of ${minTimeout}ms.`;
    }
    return { message, timed_out: timedOut };
  }

  notifyUserSteer(agentId: string) {
    this.requireAgent(agentId).mailbox.wake();
  }

  async interruptAgent(callerId: string, target: string) {
    const caller = this.requireAgent(callerId);
    const receiver = this.resolveTarget(caller, target);
    if (receiver.path === ROOT_AGENT_PATH) throw new Error('root is not a spawned agent');
    if (receiver.id === caller.id) {
      throw new Error('an agent cannot interrupt itself; return your result and let the parent interrupt you if needed');
    }
    const previousStatus = cloneAgentStatus(receiver.status);
    await receiver.runtime?.interrupt();
    receiver.status = 'interrupted';
    this.changed(receiver);
    this.activity('interrupted', caller.path, receiver.path);
    return { previous_status: previousStatus };
  }

  takeMailbox(agentId: string) {
    const agent = this.requireAgent(agentId);
    const envelopes = agent.mailbox.takeAll();
    if (envelopes.length > 0) {
      void this.persist?.({
        type: 'mailbox_dequeued',
        agentId,
        envelopeIds: envelopes.map(envelope => envelope.id),
      });
      this.changed(agent);
    }
    return envelopes;
  }

  mailboxMessages(agentId: string) {
    return this.takeMailbox(agentId).map(envelope => ({
      role: 'user' as const,
      content: formatMailboxEnvelope(envelope),
      interAgent: { triggerTurn: envelope.triggerTurn },
    }));
  }

  acquireExecution(agentId: string) {
    const agent = this.requireAgent(agentId);
    if (agent.path === ROOT_AGENT_PATH) return () => {};
    return this.execution.acquire();
  }

  updateStatus(agentId: string, status: AgentStatus) {
    const agent = this.requireAgent(agentId);
    if (status === 'running' && agent.status !== 'running') agent.turnGeneration += 1;
    agent.status = cloneAgentStatus(status);
    this.changed(agent);
    if (
      isFinalAgentStatus(status) &&
      agent.parentId &&
      agent.completionDeliveredGeneration < agent.turnGeneration
    ) {
      agent.completionDeliveredGeneration = agent.turnGeneration;
      this.notifyCompletion(agent);
      this.changed(agent);
    }
  }

  updateConfiguration(agentId: string, config: AgentConfigurationSnapshot) {
    const agent = this.requireAgent(agentId);
    agent.config = { ...config };
    agent.runtime?.updateConfiguration?.(agent.config);
    this.changed(agent);
    if (agent.path === ROOT_AGENT_PATH) {
      for (const child of this.registry.descendants(ROOT_AGENT_PATH)) {
        child.config = {
          ...child.config,
          permissionMode: config.permissionMode,
          planningMode: config.planningMode,
          cwd: config.cwd,
        };
        child.runtime?.updateConfiguration?.(child.config);
        this.changed(child);
      }
    }
  }

  setNickname(agentId: string, nickname: string | null) {
    const agent = this.requireAgent(agentId);
    agent.nickname = nickname?.trim() || null;
    this.changed(agent);
  }

  addUsage(agentId: string, usage: AgentUsage) {
    const agent = this.requireAgent(agentId);
    agent.usage = addUsage(agent.usage, usage);
    this.changed(agent);
  }

  async shutdownTree(agentId: string) {
    const target = this.requireAgent(agentId);
    const descendants = this.registry.descendants(target.path).reverse();
    for (const agent of [...descendants, target]) {
      await agent.runtime?.dispose().catch(() => {});
      agent.status = 'shutdown';
      agent.runtime = null;
      this.residency.remove(agent.id);
      this.changed(agent);
    }
  }

  async suspendTree(agentId: string) {
    const target = this.requireAgent(agentId);
    const agents = [...this.registry.descendants(target.path).reverse(), target];
    for (const agent of agents) {
      await agent.runtime?.dispose().catch(() => {});
      agent.runtime = agent.path === ROOT_AGENT_PATH ? agent.runtime : null;
      if (agent.status === 'running' || agent.status === 'pending_init') agent.status = 'interrupted';
      this.residency.remove(agent.id);
      this.changed(agent);
    }
  }

  async removeTree(agentId: string) {
    const target = this.requireAgent(agentId);
    const agents = [...this.registry.descendants(target.path).reverse(), target];
    for (const agent of agents) {
      await agent.runtime?.dispose().catch(() => {});
      this.registry.remove(agent.id);
      this.residency.remove(agent.id);
      void this.persist?.({ type: 'agent_removed', agentId: agent.id });
    }
    this.onChanged?.();
  }

  private childConfiguration(
    parent: AgentConfigurationSnapshot,
    forkTurns: ForkTurns,
    request: SpawnAgentRequest,
  ): AgentConfigurationSnapshot {
    const model = request.model ?? parent.model;
    if (!isSupportedOpenAIModel(model)) throw new Error(`Unknown model \`${model}\` for spawn_agent`);
    const thinkingMode = (request.reasoningEffort ?? parent.thinkingMode) as ThinkingMode;
    if (!getSupportedThinkingModes(model).includes(thinkingMode)) {
      throw new Error(`${model} does not support ${thinkingMode} reasoning effort`);
    }
    return {
      ...parent,
      model,
      thinkingMode,
      // Child configuration never widens authority. There is no permissions argument in V2.
      permissionMode: parent.permissionMode,
      planningMode: parent.planningMode,
    };
  }

  private forkHistoryEntries(entries: AgentState['historyEntries'], forkTurns: ForkTurns) {
    if (forkTurns === 'none') return [];
    if (forkTurns === 'all') return structuredClone(entries);
    const userIndexes = entries.flatMap((entry, index) =>
      entry.type === 'entry' && entry.kind === 'user' ? [index] : [],
    );
    const start = userIndexes[Math.max(0, userIndexes.length - forkTurns)] ?? entries.length;
    return structuredClone(entries.slice(start));
  }

  private resolveTarget(caller: RegisteredAgent, target: string) {
    const byId = this.registry.getById(target);
    const path = byId?.path ?? resolveAgentPath(caller.path, target);
    const agent = byId ?? this.registry.getByPath(path);
    if (!agent || agent.rootId !== caller.rootId) throw new Error(`live agent path \`${path}\` not found`);
    return agent;
  }

  private requireAgent(id: string) {
    const agent = this.registry.getById(id);
    if (!agent) throw new Error(`agent \`${id}\` not found`);
    return agent;
  }

  private async ensureLoaded(agent: RegisteredAgent, protectedAgentId?: string) {
    if (agent.runtime) {
      this.residency.touch(agent.id);
      return;
    }
    await this.residency.reserve({
      protectedAgentId,
      canUnload: id => this.canUnload(id),
      unload: id => this.unloadAgent(id),
    });
    agent.runtime = await this.runtimeFactory({
      agent,
      inheritedMessages: [],
      inheritedHistory: [],
      control: this,
    });
    this.residency.touch(agent.id);
    this.changed(agent);
  }

  private canUnload(agentId: string) {
    const agent = this.registry.getById(agentId);
    return Boolean(
      agent &&
      agent.path !== ROOT_AGENT_PATH &&
      agent.runtime &&
      !agent.runtime.isBusy() &&
      !agent.mailbox.hasPending() &&
      (agent.status === 'interrupted' || typeof agent.status === 'object'),
    );
  }

  private async unloadAgent(agentId: string) {
    const agent = this.requireAgent(agentId);
    await agent.runtime?.dispose();
    agent.runtime = null;
    this.residency.remove(agent.id);
    this.changed(agent);
  }

  private notifyCompletion(child: RegisteredAgent) {
    const parent = child.parentId ? this.registry.getById(child.parentId) : null;
    if (!parent) return;
    const message = typeof child.status === 'object' && 'completed' in child.status
      ? child.status.completed ?? ''
      : typeof child.status === 'object' && 'errored' in child.status
        ? child.status.errored
        : '';
    parent.mailbox.enqueue({
      kind: 'FINAL_ANSWER',
      from: child.path,
      to: parent.path,
      message,
      triggerTurn: false,
    });
    this.changed(parent);
    this.activity('completed', child.path, parent.path, message);
  }

  private activity(
    kind: CollaborationActivity['kind'],
    actorPath: string,
    targetPath?: string,
    message?: string,
  ) {
    this.onActivity?.({
      id: randomUUID(),
      kind,
      actorPath: normalizeAgentPath(actorPath),
      ...(targetPath ? { targetPath: normalizeAgentPath(targetPath) } : {}),
      ...(message ? { message } : {}),
      timestamp: new Date().toISOString(),
    });
  }

  private changed(agent: RegisteredAgent) {
    agent.updatedAt = new Date().toISOString();
    void this.persist?.({ type: 'agent_upsert', agent: this.registry.serialize(agent) });
    this.onChanged?.();
  }
}
