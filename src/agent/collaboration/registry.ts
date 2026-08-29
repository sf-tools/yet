import { randomUUID } from 'node:crypto';

import type { AgentState } from '@/store';
import type { HistoryEntry } from '@/types';
import type { AgentUsage } from '@/agent/messages';
import type { PermissionMode } from '@/permissions';
import type { ThinkingMode } from '@/config';
import { EMPTY_USAGE } from '@/agent/messages';
import { AgentMailbox, type MailboxEnvelope } from './mailbox';
import { ROOT_AGENT_PATH, normalizeAgentPath } from './agent-path';
import { cloneAgentStatus, type AgentStatus } from './status';
import { AGENT_NAMES } from './agent-names';

export type AgentRuntimeHandle = {
  start(message?: string): Promise<void>;
  interrupt(): Promise<void>;
  dispose(): Promise<void>;
  isBusy(): boolean;
  getState(): AgentState;
  getHistoryRevision(): number;
  updateConfiguration?(config: AgentConfigurationSnapshot): void;
  recordCollaborationActivity?(entry: HistoryEntry): void;
};

export type AgentConfigurationSnapshot = {
  model: string;
  thinkingMode: ThinkingMode;
  fastModeEnabled: boolean;
  permissionMode: PermissionMode;
  planningMode: boolean;
  cwd: string;
};

export type RegisteredAgent = {
  id: string;
  rootId: string;
  parentId: string | null;
  path: string;
  taskName: string;
  nickname: string | null;
  status: AgentStatus;
  config: AgentConfigurationSnapshot;
  mailbox: AgentMailbox;
  runtime: AgentRuntimeHandle | null;
  sessionRolloutPath?: string;
  createdAt: string;
  updatedAt: string;
  lastResidentAt: number;
  usage: AgentUsage;
  spawnOrder: number;
  turnGeneration: number;
  completionDeliveredGeneration: number;
};

export type PersistedRegisteredAgent = Omit<RegisteredAgent, 'mailbox' | 'runtime'> & {
  mailbox: MailboxEnvelope[];
};

export class AgentRegistry {
  private readonly byId = new Map<string, RegisteredAgent>();
  private readonly byPath = new Map<string, RegisteredAgent>();
  private readonly reservations = new Set<string>();
  private readonly usedNicknames = new Set<string>();
  private nicknameResetCount = 0;
  private spawnOrder = 0;

  registerRoot(input: {
    id: string;
    config: AgentConfigurationSnapshot;
    runtime: AgentRuntimeHandle;
    createdAt?: string;
  }) {
    const existing = this.byPath.get(ROOT_AGENT_PATH);
    if (existing && existing.id !== input.id) throw new Error('a root agent is already registered');
    const now = input.createdAt ?? new Date().toISOString();
    const agent: RegisteredAgent = existing ?? {
      id: input.id,
      rootId: input.id,
      parentId: null,
      path: ROOT_AGENT_PATH,
      taskName: 'root',
      nickname: null,
      status: 'interrupted',
      config: input.config,
      mailbox: new AgentMailbox(),
      runtime: input.runtime,
      createdAt: now,
      updatedAt: now,
      lastResidentAt: Date.now(),
      usage: { ...EMPTY_USAGE },
      spawnOrder: this.spawnOrder++,
      turnGeneration: 0,
      completionDeliveredGeneration: -1,
    };
    agent.config = input.config;
    agent.runtime = input.runtime;
    this.byId.set(agent.id, agent);
    this.byPath.set(agent.path, agent);
    return agent;
  }

  reserve(path: string) {
    const normalized = normalizeAgentPath(path);
    if (this.byPath.has(normalized) || this.reservations.has(normalized)) {
      throw new Error(`agent path \`${normalized}\` already exists`);
    }
    this.reservations.add(normalized);
    const reservedNickname = this.reserveNickname();
    let active = true;
    return {
      commit: (input: Omit<RegisteredAgent, 'id' | 'path' | 'mailbox' | 'createdAt' | 'updatedAt' | 'lastResidentAt' | 'usage' | 'spawnOrder' | 'turnGeneration' | 'completionDeliveredGeneration'> & {
        id?: string;
        mailbox?: MailboxEnvelope[];
        createdAt?: string;
      }) => {
        if (!active) throw new Error(`agent path \`${normalized}\` is no longer reserved`);
        const now = input.createdAt ?? new Date().toISOString();
        const agent: RegisteredAgent = {
          ...input,
          id: input.id ?? randomUUID(),
          path: normalized,
          nickname: input.nickname ?? reservedNickname,
          mailbox: new AgentMailbox(input.mailbox),
          createdAt: now,
          updatedAt: now,
          lastResidentAt: Date.now(),
          usage: { ...EMPTY_USAGE },
          spawnOrder: this.spawnOrder++,
          turnGeneration: 0,
          completionDeliveredGeneration: -1,
        };
        if (this.byId.has(agent.id)) throw new Error(`agent id \`${agent.id}\` already exists`);
        this.byId.set(agent.id, agent);
        this.byPath.set(normalized, agent);
        this.reservations.delete(normalized);
        active = false;
        return agent;
      },
      release: () => {
        if (!active) return;
        active = false;
        this.reservations.delete(normalized);
      },
    };
  }

  restore(input: PersistedRegisteredAgent) {
    const existing = this.byId.get(input.id) ?? this.byPath.get(input.path);
    if (existing) {
      if (existing.path === ROOT_AGENT_PATH && input.id === existing.id) {
        existing.nickname = input.nickname;
        existing.mailbox = new AgentMailbox(input.mailbox);
        existing.usage = { ...input.usage };
        existing.turnGeneration = input.turnGeneration ?? existing.turnGeneration;
        existing.completionDeliveredGeneration = input.completionDeliveredGeneration ?? existing.completionDeliveredGeneration;
        existing.updatedAt = input.updatedAt;
      }
      return existing;
    }
    const agent: RegisteredAgent = {
      ...input,
      path: normalizeAgentPath(input.path),
      status: cloneAgentStatus(input.status),
      config: { ...input.config },
      mailbox: new AgentMailbox(input.mailbox),
      runtime: null,
      usage: { ...input.usage },
      spawnOrder: input.spawnOrder,
      turnGeneration: input.turnGeneration ?? 0,
      completionDeliveredGeneration: input.completionDeliveredGeneration ?? -1,
    };
    this.spawnOrder = Math.max(this.spawnOrder, agent.spawnOrder + 1);
    if (agent.nickname) this.usedNicknames.add(agent.nickname);
    this.byId.set(agent.id, agent);
    this.byPath.set(agent.path, agent);
    return agent;
  }

  getById(id: string) {
    return this.byId.get(id) ?? null;
  }

  getByPath(path: string) {
    return this.byPath.get(normalizeAgentPath(path)) ?? null;
  }

  all() {
    return [...this.byId.values()].sort((left, right) => left.spawnOrder - right.spawnOrder);
  }

  descendants(path: string) {
    const prefix = `${normalizeAgentPath(path)}/`;
    return this.all().filter(agent => agent.path.startsWith(prefix));
  }

  remove(id: string) {
    const agent = this.byId.get(id);
    if (!agent) return null;
    this.byId.delete(id);
    this.byPath.delete(agent.path);
    return agent;
  }

  serialize(agent: RegisteredAgent): PersistedRegisteredAgent {
    const { runtime: _runtime, mailbox: _mailbox, ...persisted } = agent;
    return {
      ...persisted,
      status: cloneAgentStatus(agent.status),
      config: { ...agent.config },
      mailbox: agent.mailbox.pending(),
      usage: { ...agent.usage },
    };
  }

  private reserveNickname() {
    const formatted = (name: string) => {
      if (this.nicknameResetCount === 0) return name;
      const value = this.nicknameResetCount + 1;
      const suffix = value % 100 >= 11 && value % 100 <= 13
        ? 'th'
        : value % 10 === 1
          ? 'st'
          : value % 10 === 2
            ? 'nd'
            : value % 10 === 3
              ? 'rd'
              : 'th';
      return `${name} the ${value}${suffix}`;
    };
    let available = AGENT_NAMES.map(formatted).filter(name => !this.usedNicknames.has(name));
    if (available.length === 0) {
      this.usedNicknames.clear();
      this.nicknameResetCount += 1;
      available = AGENT_NAMES.map(formatted);
    }
    const random = Number.parseInt(randomUUID().replaceAll('-', '').slice(0, 8), 16);
    const nickname = available[random % available.length]!;
    this.usedNicknames.add(nickname);
    return nickname;
  }
}
