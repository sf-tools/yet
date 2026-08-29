import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import {
  appendFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import type {
  AgentMessage,
  AgentToolCallMessage,
  AgentToolResultMessage,
  AgentUsage,
} from '@/agent/messages';
import { EMPTY_USAGE } from '@/agent/messages';
import { createInitialState } from '@/store/state';
import type { AgentState } from '@/store/types';
import type { AgentConfigurationSnapshot } from '@/agent/collaboration/registry';
import { EntryKind, type HistoryEntry, type ToolHistoryEntry } from '@/types';

export type PersistedSessionState = {
  messages: AgentState['messages'];
  historyEntries: AgentState['historyEntries'];
  inputChars: string[];
  cursor: number;
  totalCost: number;
  sessionUsage: AgentUsage;
  currentModel: string;
  thinkingMode: AgentState['thinkingMode'];
  fastModeEnabled: boolean;
  permissionMode: AgentState['permissionMode'];
  autoCompactEnabled: boolean;
  planningMode: boolean;
  showThinking: boolean;
  showCommandSummaries?: boolean;
  goal?: AgentState['goal'];
};

export type YetSessionListEntry = {
  sessionId: string;
  cwd: string;
  createdAt: string;
  savedAt: string;
  title?: string;
  preview?: string;
  rolloutPath?: string;
  archivedAt?: string;
  parentSessionId?: string;
  forkPoint?: number;
  rootSessionId?: string;
  agentPath?: string;
};

export type YetSessionPromptHistoryEntry = {
  text: string;
  cwd: string;
  createdAt: string;
};

export type LoadedYetSession = {
  version: 2;
  sessionId: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  name?: string;
  rolloutPath: string;
  archivedAt?: string;
  parentSessionId?: string;
  forkPoint?: number;
  rootSessionId?: string;
  agentPath?: string;
  agentForkMode?: string;
  agentConfig?: AgentConfigurationSnapshot;
  state: PersistedSessionState;
};

export type ThreadNameSource = 'provisional' | 'generated' | 'manual';

type TurnContextPayload = {
  model: string;
  thinkingMode: AgentState['thinkingMode'];
  fastModeEnabled: boolean;
  permissionMode: AgentState['permissionMode'];
  autoCompactEnabled: boolean;
  planningMode: boolean;
  showThinking: boolean;
  showCommandSummaries?: boolean;
  goal?: AgentState['goal'];
};

export type YetSessionEvent =
  | {
      type: 'session_meta';
      payload: {
        version: 2;
        sessionId: string;
        cwd: string;
        createdAt: string;
        parentSessionId?: string;
        forkPoint?: number;
        rootSessionId?: string;
        agentPath?: string;
        agentForkMode?: string;
        agentConfig?: AgentConfigurationSnapshot;
      };
    }
  | { type: 'fork_snapshot'; payload: { state: PersistedSessionState } }
  | {
      type: 'thread_name_updated';
      payload: { name: string; source: ThreadNameSource; expectedName?: string };
    }
  | { type: 'turn_context'; payload: TurnContextPayload }
  | {
      type: 'user_message';
      payload: { messages?: AgentMessage[]; entries?: HistoryEntry[] };
    }
  | {
      type: 'assistant_message';
      payload: { messages?: AgentMessage[]; entries?: HistoryEntry[] };
    }
  | { type: 'reasoning'; payload: { entries: HistoryEntry[] } }
  | {
      type: 'tool_call';
      payload: { entry: ToolHistoryEntry; message?: AgentToolCallMessage };
    }
  | {
      type: 'tool_result';
      payload: { entry: ToolHistoryEntry; message?: AgentToolResultMessage };
    }
  | { type: 'transcript_entry'; payload: { entries: HistoryEntry[] } }
  | {
      type: 'usage_updated';
      payload: { lastUsage: AgentUsage; sessionUsage: AgentUsage; totalCost: number };
    }
  | {
      type: 'compacted';
      payload: {
        messages: AgentMessage[];
        entry: Extract<HistoryEntry, { type: 'compacted' }>;
        usage: AgentUsage;
        sessionUsage: AgentUsage;
      };
    };

export type YetRolloutLine = YetSessionEvent & {
  timestamp: string;
  ordinal: number;
};

export type SessionIndexEntry = {
  sessionId: string;
  rolloutPath: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  name?: string;
  preview?: string;
  model?: string;
  lastOrdinal: number;
  rolloutBytes?: number;
  archivedAt?: string;
  parentSessionId?: string;
  forkPoint?: number;
  rootSessionId?: string;
  agentPath?: string;
  agentForkMode?: string;
  agentConfig?: AgentConfigurationSnapshot;
};

type SessionMetadata = Omit<SessionIndexEntry, 'rolloutPath'>;

const DEFAULT_YET_HOME = join(homedir(), '.yet');
const SESSION_INDEX_FILE = 'session_index.jsonl';
const SESSION_DIRECTORY = 'sessions';
const ARCHIVED_SESSION_DIRECTORY = 'archived_sessions';
const LOCK_DIRECTORY = 'locks';

function normalizeWhitespace(text: string) {
  return text.replace(/\s+/g, ' ').trim();
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function persistedStateFromAgentState(
  state: AgentState,
  keepDraft = false,
): PersistedSessionState {
  return {
    messages: cloneJson(state.messages),
    historyEntries: cloneJson(state.historyEntries),
    inputChars: keepDraft ? [...state.inputChars] : [],
    cursor: keepDraft ? state.cursor : 0,
    totalCost: state.totalCost,
    sessionUsage: cloneJson(state.sessionUsage),
    currentModel: state.currentModel,
    thinkingMode: state.thinkingMode,
    fastModeEnabled: state.fastModeEnabled,
    permissionMode: state.permissionMode,
    autoCompactEnabled: state.autoCompactEnabled,
    planningMode: state.planningMode,
    showThinking: state.showThinking,
    showCommandSummaries: state.showCommandSummaries,
    goal: state.goal ? cloneJson(state.goal) : null,
  };
}

function sanitizeHistoryEntriesForResume(entries: HistoryEntry[]): HistoryEntry[] {
  return entries.map(entry => {
    if (entry.type !== 'tool' || entry.status !== 'running') return entry;
    return {
      ...entry,
      status: 'failed',
      errorText: entry.errorText || 'interrupted when the session was resumed',
    };
  });
}

function removeLegacySessionSwitchHandoffs(
  entries: HistoryEntry[],
  parentSessionId?: string,
): HistoryEntry[] {
  const parentResumeCommand = parentSessionId ? `yet resume ${parentSessionId}` : null;
  const isInvalidResumeHint = (entry: HistoryEntry | undefined) =>
    entry?.type === 'resume_hint' && entry.command !== parentResumeCommand;

  return entries.filter((entry, index) => {
    if (isInvalidResumeHint(entry)) return false;
    return !(
      entry.type === 'plain' &&
      entry.text.startsWith('Token usage: ') &&
      isInvalidResumeHint(entries[index + 1])
    );
  });
}

function sanitizeMessagesForResume(messages: AgentMessage[]): AgentMessage[] {
  const completedToolCalls = new Set(
    messages.flatMap(message => (message.role === 'tool-result' ? [message.callId] : [])),
  );
  const sanitized: AgentMessage[] = [];
  for (const message of messages) {
    sanitized.push(message);
    if (message.role !== 'tool-call' || completedToolCalls.has(message.callId)) continue;
    sanitized.push({
      role: 'tool-result',
      callId: message.callId,
      output: JSON.stringify({
        ok: false,
        error: 'interrupted when the session was resumed',
      }),
    });
  }
  return sanitized;
}

export function hydratePersistedState(persisted: PersistedSessionState): AgentState {
  const initial = createInitialState();
  return {
    ...initial,
    autoCompactEnabled: persisted.autoCompactEnabled,
    currentModel: persisted.currentModel,
    cursor: persisted.cursor,
    historyEntries: sanitizeHistoryEntriesForResume(persisted.historyEntries),
    inputChars: persisted.inputChars,
    messages: sanitizeMessagesForResume(persisted.messages),
    fastModeEnabled: persisted.fastModeEnabled ?? false,
    planningMode: persisted.planningMode,
    permissionMode: persisted.permissionMode ?? initial.permissionMode,
    showThinking: persisted.showThinking ?? initial.showThinking,
    showCommandSummaries: persisted.showCommandSummaries ?? initial.showCommandSummaries,
    goal: persisted.goal ? cloneJson(persisted.goal) : null,
    thinkingMode: persisted.thinkingMode,
    sessionUsage: cloneJson(persisted.sessionUsage ?? EMPTY_USAGE),
    totalCost: persisted.totalCost,
    sideConversation: null,
  };
}

export function hydrateStateFromSession(session: LoadedYetSession): AgentState {
  const state = hydratePersistedState(session.state);
  state.historyEntries = removeLegacySessionSwitchHandoffs(
    state.historyEntries,
    session.parentSessionId,
  );
  return state;
}

function firstUserPreview(entries: HistoryEntry[]) {
  for (const entry of entries) {
    if (entry.type !== 'entry' || entry.kind !== EntryKind.User) continue;
    const preview = normalizeWhitespace(entry.text);
    if (preview) return preview;
  }
  return undefined;
}

function upsertToolEntry(entries: HistoryEntry[], entry: ToolHistoryEntry) {
  const index = entries.findIndex(
    candidate => candidate.type === 'tool' && candidate.toolCallId === entry.toolCallId,
  );
  if (index === -1) entries.push(entry);
  else entries[index] = entry;
}

function setUsage(state: AgentState, lastUsage: AgentUsage, sessionUsage: AgentUsage) {
  state.lastPromptTokens = lastUsage.inputTokens;
  state.lastOutputTokens = lastUsage.outputTokens;
  state.lastReasoningTokens = lastUsage.reasoningTokens;
  state.sessionUsage = cloneJson(sessionUsage);
}

function applyEvent(state: AgentState, event: YetSessionEvent) {
  switch (event.type) {
    case 'session_meta':
    case 'thread_name_updated':
      break;
    case 'fork_snapshot':
      Object.assign(state, hydratePersistedState(event.payload.state));
      break;
    case 'turn_context':
      state.currentModel = event.payload.model;
      state.thinkingMode = event.payload.thinkingMode;
      state.fastModeEnabled = event.payload.fastModeEnabled ?? false;
      state.permissionMode = event.payload.permissionMode;
      state.autoCompactEnabled = event.payload.autoCompactEnabled;
      state.planningMode = event.payload.planningMode;
      state.showThinking = event.payload.showThinking;
      state.showCommandSummaries = event.payload.showCommandSummaries ?? false;
      state.goal = event.payload.goal ? cloneJson(event.payload.goal) : null;
      break;
    case 'user_message':
    case 'assistant_message':
      if (event.payload.messages) state.messages.push(...event.payload.messages);
      if (event.payload.entries) state.historyEntries.push(...event.payload.entries);
      break;
    case 'reasoning':
    case 'transcript_entry':
      state.historyEntries.push(...event.payload.entries);
      break;
    case 'tool_call':
    case 'tool_result':
      if (event.payload.message) state.messages.push(event.payload.message);
      upsertToolEntry(state.historyEntries, event.payload.entry);
      break;
    case 'usage_updated':
      setUsage(state, event.payload.lastUsage, event.payload.sessionUsage);
      state.totalCost = event.payload.totalCost;
      break;
    case 'compacted':
      state.messages.splice(0, state.messages.length, ...event.payload.messages);
      state.historyEntries.push(event.payload.entry);
      setUsage(state, event.payload.usage, event.payload.sessionUsage);
      break;
  }
}

function nameFromLines(lines: YetRolloutLine[]) {
  let name: string | undefined;
  for (const line of lines) {
    if (line.type !== 'thread_name_updated') continue;
    if (line.payload.expectedName && line.payload.expectedName !== name) continue;
    name = normalizeWhitespace(line.payload.name) || undefined;
  }
  return name;
}

function sessionMetaFromLines(lines: YetRolloutLine[]) {
  return lines.find(line => line.type === 'session_meta')?.payload as
    | Extract<YetSessionEvent, { type: 'session_meta' }>['payload']
    | undefined;
}

function parseRolloutText(raw: string) {
  const complete = raw.endsWith('\n') ? raw : raw.slice(0, Math.max(0, raw.lastIndexOf('\n') + 1));
  const lines: YetRolloutLine[] = [];
  for (const text of complete.split('\n')) {
    if (!text.trim()) continue;
    const line = parseRolloutLine(text);
    if (line) lines.push(line);
  }
  const latestByOrdinal = new Map<number, YetRolloutLine>();
  for (const line of lines) latestByOrdinal.set(line.ordinal, line);
  return [...latestByOrdinal.values()].sort((left, right) => left.ordinal - right.ordinal);
}

function parseRolloutLine(text: string): YetRolloutLine | null {
  try {
    const line = JSON.parse(text) as YetRolloutLine;
    if (
      line &&
      typeof line.timestamp === 'string' &&
      Number.isSafeInteger(line.ordinal) &&
      line.ordinal >= 0 &&
      typeof line.type === 'string' &&
      line.payload &&
      typeof line.payload === 'object'
    ) {
      return line;
    }
  } catch {
    // A malformed record does not make later independently framed JSONL records unreadable.
  }
  return null;
}

export async function readYetRollout(path: string) {
  return parseRolloutText(await readFile(path, 'utf8'));
}

function readYetRolloutSync(path: string) {
  return parseRolloutText(readFileSync(path, 'utf8'));
}

function loadedSessionFromLines(lines: YetRolloutLine[], rolloutPath: string): LoadedYetSession | null {
  const meta = sessionMetaFromLines(lines);
  if (!meta || meta.version !== 2 || !meta.sessionId || !meta.cwd) return null;

  const state = createInitialState();
  for (const line of lines) applyEvent(state, line);
  const savedAt = lines.at(-1)?.timestamp ?? meta.createdAt;
  const title = nameFromLines(lines);

  return {
    version: 2,
    sessionId: meta.sessionId,
    cwd: meta.cwd,
    createdAt: meta.createdAt,
    updatedAt: savedAt,
    ...(title ? { name: title } : {}),
    rolloutPath,
    ...(meta.parentSessionId ? { parentSessionId: meta.parentSessionId } : {}),
    ...(typeof meta.forkPoint === 'number' ? { forkPoint: meta.forkPoint } : {}),
    ...(meta.rootSessionId ? { rootSessionId: meta.rootSessionId } : {}),
    ...(meta.agentPath ? { agentPath: meta.agentPath } : {}),
    ...(meta.agentForkMode ? { agentForkMode: meta.agentForkMode } : {}),
    ...(meta.agentConfig ? { agentConfig: cloneJson(meta.agentConfig) } : {}),
    state: persistedStateFromAgentState(
      {
        ...state,
        historyEntries: sanitizeHistoryEntriesForResume(state.historyEntries),
        messages: sanitizeMessagesForResume(state.messages),
      },
      true,
    ),
  };
}

function metadataFromLoadedSession(session: LoadedYetSession, rolloutPath: string): SessionIndexEntry {
  const preview = firstUserPreview(session.state.historyEntries);
  return {
    sessionId: session.sessionId,
    rolloutPath,
    cwd: session.cwd,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    ...(session.name ? { name: session.name } : {}),
    ...(preview ? { preview } : {}),
    model: session.state.currentModel,
    lastOrdinal: -1,
    ...(session.archivedAt ? { archivedAt: session.archivedAt } : {}),
    ...(session.parentSessionId ? { parentSessionId: session.parentSessionId } : {}),
    ...(typeof session.forkPoint === 'number' ? { forkPoint: session.forkPoint } : {}),
    ...(session.rootSessionId ? { rootSessionId: session.rootSessionId } : {}),
    ...(session.agentPath ? { agentPath: session.agentPath } : {}),
    ...(session.agentForkMode ? { agentForkMode: session.agentForkMode } : {}),
    ...(session.agentConfig ? { agentConfig: cloneJson(session.agentConfig) } : {}),
  };
}

function indexPath(yetHome: string) {
  return join(yetHome, SESSION_INDEX_FILE);
}

function rolloutPathFromIndex(entry: SessionIndexEntry, yetHome: string) {
  const path = isAbsolute(entry.rolloutPath) ? entry.rolloutPath : resolve(yetHome, entry.rolloutPath);
  const pathRelativeToHome = relative(resolve(yetHome), path);
  if (pathRelativeToHome.startsWith('..') || isAbsolute(pathRelativeToHome)) return null;
  return path;
}

function validIndexEntry(value: unknown): value is SessionIndexEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<SessionIndexEntry>;
  return (
    typeof entry.sessionId === 'string' &&
    typeof entry.rolloutPath === 'string' &&
    typeof entry.cwd === 'string' &&
    typeof entry.createdAt === 'string' &&
    typeof entry.updatedAt === 'string' &&
    typeof entry.lastOrdinal === 'number'
  );
}

function parseIndex(raw: string) {
  const entries = new Map<string, SessionIndexEntry>();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as unknown;
      if (validIndexEntry(entry)) entries.set(entry.sessionId, entry);
    } catch {
      // The index is a rebuildable cache; malformed records never invalidate the rollout.
    }
  }
  return entries;
}

async function appendIndexEntry(entry: SessionIndexEntry, yetHome: string) {
  await mkdir(yetHome, { recursive: true });
  await appendFile(indexPath(yetHome), `${JSON.stringify(entry)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

async function removeIndexEntry(sessionId: string, yetHome: string) {
  let entries = new Map<string, SessionIndexEntry>();
  try {
    entries = parseIndex(await readFile(indexPath(yetHome), 'utf8'));
  } catch {}
  entries.delete(sessionId);

  await mkdir(yetHome, { recursive: true });
  const temporaryPath = join(yetHome, `.session-index-${process.pid}-${randomUUID()}.tmp`);
  const contents = [...entries.values()].map(entry => JSON.stringify(entry)).join('\n');
  try {
    await writeFile(temporaryPath, contents ? `${contents}\n` : '', {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(temporaryPath, indexPath(yetHome));
  } finally {
    await unlink(temporaryPath).catch(() => {});
  }
}

async function findRolloutPaths(root: string): Promise<string[]> {
  const paths: string[] = [];
  async function visit(path: string) {
    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) paths.push(child);
    }
  }
  await visit(root);
  return paths;
}

function findRolloutPathsSync(root: string) {
  const paths: string[] = [];
  function visit(path: string) {
    let entries;
    try {
      entries = readdirSync(path, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) paths.push(child);
    }
  }
  visit(root);
  return paths;
}

async function reconcileIndex(
  entries: Map<string, SessionIndexEntry>,
  yetHome: string,
  persistRepairs: boolean,
) {
  const indexedPaths = new Map(
    [...entries.values()].flatMap(entry => {
      const path = rolloutPathFromIndex(entry, yetHome);
      return path ? [[resolve(path), entry] as const] : [];
    }),
  );
  const roots = [
    { path: join(yetHome, SESSION_DIRECTORY), archived: false },
    { path: join(yetHome, ARCHIVED_SESSION_DIRECTORY), archived: true },
  ];
  for (const root of roots) for (const path of await findRolloutPaths(root.path)) {
    try {
      const existing = indexedPaths.get(resolve(path));
      const rolloutBytes = statSync(path).size;
      if (existing?.rolloutBytes === rolloutBytes) continue;
      const lines = await readYetRollout(path);
      const loaded = loadedSessionFromLines(lines, path);
      if (!loaded) continue;
      if (root.archived) loaded.archivedAt = existing?.archivedAt ?? loaded.updatedAt;
      const entry = metadataFromLoadedSession(loaded, relative(yetHome, path));
      entry.lastOrdinal = lines.at(-1)?.ordinal ?? -1;
      entry.rolloutBytes = rolloutBytes;
      entries.set(entry.sessionId, entry);
      if (persistRepairs) await appendIndexEntry(entry, yetHome);
    } catch {
      // Keep reconciling from the remaining canonical rollouts.
    }
  }
  return entries;
}

async function readIndex(yetHome: string) {
  let entries = new Map<string, SessionIndexEntry>();
  try {
    entries = parseIndex(await readFile(indexPath(yetHome), 'utf8'));
  } catch {}
  return reconcileIndex(entries, yetHome, true);
}

function readIndexSync(yetHome: string) {
  let entries = new Map<string, SessionIndexEntry>();
  try {
    entries = parseIndex(readFileSync(indexPath(yetHome), 'utf8'));
  } catch {}

  const indexedPaths = new Map(
    [...entries.values()].flatMap(entry => {
      const path = rolloutPathFromIndex(entry, yetHome);
      return path ? [[resolve(path), entry] as const] : [];
    }),
  );
  const roots = [
    { path: join(yetHome, SESSION_DIRECTORY), archived: false },
    { path: join(yetHome, ARCHIVED_SESSION_DIRECTORY), archived: true },
  ];
  for (const root of roots) for (const path of findRolloutPathsSync(root.path)) {
    try {
      const existing = indexedPaths.get(resolve(path));
      const rolloutBytes = statSync(path).size;
      if (existing?.rolloutBytes === rolloutBytes) continue;
      const lines = readYetRolloutSync(path);
      const loaded = loadedSessionFromLines(lines, path);
      if (!loaded) continue;
      if (root.archived) loaded.archivedAt = existing?.archivedAt ?? loaded.updatedAt;
      const entry = metadataFromLoadedSession(loaded, relative(yetHome, path));
      entry.lastOrdinal = lines.at(-1)?.ordinal ?? -1;
      entry.rolloutBytes = rolloutBytes;
      entries.set(entry.sessionId, entry);
    } catch {}
  }
  return entries;
}

function listEntriesFromIndex(entries: Map<string, SessionIndexEntry>, yetHome: string) {
  return [...entries.values()].flatMap(entry => {
    const path = rolloutPathFromIndex(entry, yetHome);
    if (!path || !existsSync(path)) return [];
    return [
      {
        sessionId: entry.sessionId,
        cwd: entry.cwd,
        createdAt: entry.createdAt,
        savedAt: entry.updatedAt,
        ...(entry.name ? { title: entry.name } : {}),
        ...(entry.preview ? { preview: entry.preview } : {}),
        rolloutPath: path,
        ...(entry.archivedAt ? { archivedAt: entry.archivedAt } : {}),
        ...(entry.parentSessionId ? { parentSessionId: entry.parentSessionId } : {}),
        ...(typeof entry.forkPoint === 'number' ? { forkPoint: entry.forkPoint } : {}),
        ...(entry.rootSessionId ? { rootSessionId: entry.rootSessionId } : {}),
        ...(entry.agentPath ? { agentPath: entry.agentPath } : {}),
      } satisfies YetSessionListEntry,
    ];
  });
}

function filterAndSortEntries(entries: YetSessionListEntry[], cwd?: string, archived = false) {
  const targetCwd = cwd ? resolve(cwd) : null;
  return entries
    .filter(entry => Boolean(entry.archivedAt) === archived)
    .filter(entry => !entry.agentPath || entry.agentPath === '/root')
    .filter(entry => !targetCwd || resolve(entry.cwd) === targetCwd)
    .sort((left, right) => Date.parse(right.savedAt) - Date.parse(left.savedAt));
}

export async function listYetSessions(
  options: { cwd?: string; yetHome?: string; archived?: boolean } = {},
): Promise<YetSessionListEntry[]> {
  const yetHome = options.yetHome ?? DEFAULT_YET_HOME;
  return filterAndSortEntries(
    listEntriesFromIndex(await readIndex(yetHome), yetHome),
    options.cwd,
    options.archived,
  );
}

export async function listYetSessionPrompts(
  options: { cwd: string; yetHome?: string; limit?: number },
): Promise<YetSessionPromptHistoryEntry[]> {
  const yetHome = options.yetHome ?? DEFAULT_YET_HOME;
  const workspace = resolve(options.cwd);
  const limit = Math.max(1, options.limit ?? 1000);
  const sessions = listEntriesFromIndex(await readIndex(yetHome), yetHome)
    .filter(session => !session.agentPath || session.agentPath === '/root')
    .filter(session => resolve(session.cwd) === workspace)
    .sort((left, right) => Date.parse(right.savedAt) - Date.parse(left.savedAt));
  const prompts: Array<YetSessionPromptHistoryEntry & { ordinal: number }> = [];

  for (const session of sessions) {
    if (!session.rolloutPath) continue;
    let lines: YetRolloutLine[];
    try {
      lines = await readYetRollout(session.rolloutPath);
    } catch {
      continue;
    }

    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const event = lines[index];
      if (event?.type !== 'user_message' || !event.payload.entries) continue;
      for (let entryIndex = event.payload.entries.length - 1; entryIndex >= 0; entryIndex -= 1) {
        const entry = event.payload.entries[entryIndex];
        if (entry?.type !== 'entry' || entry.kind !== EntryKind.User) continue;
        const text = (entry.turn?.prompt ?? entry.text).trim();
        if (!text) continue;
        prompts.push({
          text,
          cwd: session.cwd,
          createdAt: event.timestamp,
          ordinal: event.ordinal,
        });
      }
    }

    if (prompts.length >= limit) break;
  }

  return prompts
    .sort((left, right) =>
      Date.parse(right.createdAt) - Date.parse(left.createdAt) || right.ordinal - left.ordinal,
    )
    .slice(0, limit)
    .map(({ ordinal: _ordinal, ...entry }) => entry);
}

export function listYetSessionsSync(
  options: { cwd?: string; yetHome?: string; archived?: boolean } = {},
): YetSessionListEntry[] {
  const yetHome = options.yetHome ?? DEFAULT_YET_HOME;
  return filterAndSortEntries(
    listEntriesFromIndex(readIndexSync(yetHome), yetHome),
    options.cwd,
    options.archived,
  );
}

function normalizeSessionReference(value: string) {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

export function resolveYetSessionReferenceFromList(
  sessions: YetSessionListEntry[],
  reference: string,
) {
  const normalized = normalizeSessionReference(reference);
  if (!normalized) return null;

  const exactId = sessions.find(session => session.sessionId.toLowerCase() === normalized);
  if (exactId) return exactId;

  const idPrefixMatches = sessions.filter(session =>
    session.sessionId.toLowerCase().startsWith(normalized),
  );
  if (idPrefixMatches.length === 1) return idPrefixMatches[0];
  if (idPrefixMatches.length > 1)
    throw new Error(`multiple saved sessions match '${reference}'`);

  const nameMatches = sessions.filter(
    session => session.title && normalizeSessionReference(session.title) === normalized,
  );
  if (nameMatches.length === 1) return nameMatches[0];
  if (nameMatches.length > 1)
    throw new Error(`multiple saved sessions are named '${reference}'`);
  return null;
}

export async function resolveYetSessionReference(
  reference: string,
  options: { yetHome?: string; archived?: boolean } = {},
) {
  return resolveYetSessionReferenceFromList(
    await listYetSessions({ yetHome: options.yetHome, archived: options.archived }),
    reference,
  );
}

function formatTimestampForPath(date: Date) {
  return date.toISOString().replace(/:/g, '-').replace(/\.\d{3}Z$/, 'Z');
}

function newRolloutPath(sessionId: string, createdAt: string, yetHome: string) {
  const date = new Date(createdAt);
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return join(
    yetHome,
    SESSION_DIRECTORY,
    year,
    month,
    day,
    `rollout-${formatTimestampForPath(date)}-${sessionId}.jsonl`,
  );
}

type SessionLock = { path: string; token: string };

function processIsAlive(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function acquireSessionLock(sessionId: string, yetHome: string): Promise<SessionLock> {
  const path = join(yetHome, LOCK_DIRECTORY, `${sessionId}.lock`);
  await mkdir(dirname(path), { recursive: true });
  const token = randomUUID();
  const contents = JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, 'wx', 0o600);
      await handle.writeFile(contents, 'utf8');
      await handle.close();
      return { path, token };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let owner: { pid?: number } = {};
      try {
        owner = JSON.parse(await readFile(path, 'utf8')) as { pid?: number };
      } catch {}
      if (typeof owner.pid === 'number' && processIsAlive(owner.pid))
        throw new Error(`session '${sessionId}' is already open in process ${owner.pid}`);
      if (attempt === 0) {
        await unlink(path).catch(() => {});
        continue;
      }
      throw new Error(`could not acquire the writer lock for session '${sessionId}'`);
    }
  }
  throw new Error(`could not acquire the writer lock for session '${sessionId}'`);
}

async function releaseSessionLock(lock: SessionLock) {
  try {
    const contents = JSON.parse(await readFile(lock.path, 'utf8')) as { token?: string };
    if (contents.token === lock.token) await unlink(lock.path);
  } catch {}
}

async function repairTrailingPartialLine(path: string) {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  if (!raw || raw.endsWith('\n')) return parseRolloutText(raw);
  const finalNewline = raw.lastIndexOf('\n');
  const trailingRecord = raw.slice(finalNewline + 1);
  if (parseRolloutLine(trailingRecord)) {
    await appendFile(path, '\n', { encoding: 'utf8', mode: 0o600 });
    return parseRolloutText(`${raw}\n`);
  }
  const complete = finalNewline < 0 ? '' : raw.slice(0, finalNewline + 1);
  await writeFile(path, complete, { encoding: 'utf8', mode: 0o600 });
  return parseRolloutText(complete);
}

function metadataFromEvent(metadata: SessionMetadata, event: YetSessionEvent, timestamp: string) {
  metadata.updatedAt = timestamp;
  if (
    event.type === 'thread_name_updated' &&
    (!event.payload.expectedName || event.payload.expectedName === metadata.name)
  ) {
    metadata.name = normalizeWhitespace(event.payload.name);
  }
  if (event.type === 'turn_context') metadata.model = event.payload.model;
  if (!metadata.preview) {
    const entries = event.type === 'user_message' ? event.payload.entries : undefined;
    const preview = entries ? firstUserPreview(entries) : undefined;
    if (preview) metadata.preview = preview;
  }
}

export function createTurnContextEvent(
  state: AgentState,
): Extract<YetSessionEvent, { type: 'turn_context' }> {
  return {
    type: 'turn_context',
    payload: {
      model: state.currentModel,
      thinkingMode: state.thinkingMode,
      fastModeEnabled: state.fastModeEnabled,
      permissionMode: state.permissionMode,
      autoCompactEnabled: state.autoCompactEnabled,
      planningMode: state.planningMode,
      showThinking: state.showThinking,
      showCommandSummaries: state.showCommandSummaries,
      goal: state.goal ? cloneJson(state.goal) : null,
    },
  };
}

export class SessionRecorder {
  readonly sessionId: string;
  readonly rolloutPath: string;

  private readonly yetHome: string;
  private readonly lock: SessionLock;
  private readonly metadata: SessionMetadata;
  private pendingMeta: Extract<YetSessionEvent, { type: 'session_meta' }> | null;
  private readonly pendingEvents: YetSessionEvent[] = [];
  private handle: FileHandle | null = null;
  private nextOrdinal: number;
  private operation = Promise.resolve();
  private indexDirty = false;
  private closed = false;

  private constructor(options: {
    sessionId: string;
    cwd: string;
    createdAt: string;
    rolloutPath: string;
    yetHome: string;
    lock: SessionLock;
    lines: YetRolloutLine[];
    title?: string;
    parentSessionId?: string;
    forkPoint?: number;
    rootSessionId?: string;
    agentPath?: string;
    agentForkMode?: string;
    agentConfig?: AgentConfigurationSnapshot;
  }) {
    this.sessionId = options.sessionId;
    this.rolloutPath = options.rolloutPath;
    this.yetHome = options.yetHome;
    this.lock = options.lock;
    this.nextOrdinal = (options.lines.at(-1)?.ordinal ?? -1) + 1;
    this.pendingMeta = options.lines.length
      ? null
      : {
          type: 'session_meta',
          payload: {
            version: 2,
            sessionId: options.sessionId,
            cwd: options.cwd,
            createdAt: options.createdAt,
            ...(options.parentSessionId ? { parentSessionId: options.parentSessionId } : {}),
            ...(typeof options.forkPoint === 'number' ? { forkPoint: options.forkPoint } : {}),
            ...(options.rootSessionId ? { rootSessionId: options.rootSessionId } : {}),
            ...(options.agentPath ? { agentPath: options.agentPath } : {}),
            ...(options.agentForkMode ? { agentForkMode: options.agentForkMode } : {}),
            ...(options.agentConfig ? { agentConfig: cloneJson(options.agentConfig) } : {}),
          },
        };
    this.metadata = {
      sessionId: options.sessionId,
      cwd: options.cwd,
      createdAt: options.createdAt,
      updatedAt: options.lines.at(-1)?.timestamp ?? options.createdAt,
      ...(options.title ? { name: options.title } : {}),
      lastOrdinal: this.nextOrdinal - 1,
      ...(options.parentSessionId ? { parentSessionId: options.parentSessionId } : {}),
      ...(typeof options.forkPoint === 'number' ? { forkPoint: options.forkPoint } : {}),
      ...(options.rootSessionId ? { rootSessionId: options.rootSessionId } : {}),
      ...(options.agentPath ? { agentPath: options.agentPath } : {}),
      ...(options.agentForkMode ? { agentForkMode: options.agentForkMode } : {}),
      ...(options.agentConfig ? { agentConfig: cloneJson(options.agentConfig) } : {}),
    };
    for (const line of options.lines) metadataFromEvent(this.metadata, line, line.timestamp);
  }

  static async open(options: {
    sessionId: string;
    cwd: string;
    rolloutPath?: string;
    createdAt?: string;
    title?: string;
    yetHome?: string;
    parentSessionId?: string;
    forkPoint?: number;
    rootSessionId?: string;
    agentPath?: string;
    agentForkMode?: string;
    agentConfig?: AgentConfigurationSnapshot;
  }) {
    const yetHome = options.yetHome ?? DEFAULT_YET_HOME;
    const createdAt = options.createdAt ?? new Date().toISOString();
    const rolloutPath = options.rolloutPath ?? newRolloutPath(options.sessionId, createdAt, yetHome);
    const lock = await acquireSessionLock(options.sessionId, yetHome);
    try {
      const lines = await repairTrailingPartialLine(rolloutPath);
      const meta = sessionMetaFromLines(lines);
      if (meta && meta.sessionId !== options.sessionId)
        throw new Error(`rollout '${rolloutPath}' belongs to a different session`);
      return new SessionRecorder({
        sessionId: options.sessionId,
        cwd: meta?.cwd ?? options.cwd,
        createdAt: meta?.createdAt ?? createdAt,
        rolloutPath,
        yetHome,
        lock,
        lines,
        title: options.title ?? nameFromLines(lines),
        parentSessionId: meta?.parentSessionId ?? options.parentSessionId,
        forkPoint: meta?.forkPoint ?? options.forkPoint,
        rootSessionId: meta?.rootSessionId ?? options.rootSessionId,
        agentPath: meta?.agentPath ?? options.agentPath,
        agentForkMode: meta?.agentForkMode ?? options.agentForkMode,
        agentConfig: meta?.agentConfig ?? options.agentConfig,
      });
    } catch (error) {
      await releaseSessionLock(lock);
      throw error;
    }
  }

  get lastOrdinal() {
    return this.nextOrdinal - 1;
  }

  get isClosed() {
    return this.closed;
  }

  record(event: Exclude<YetSessionEvent, { type: 'session_meta' }>) {
    if (this.closed) throw new Error('cannot record an event after the session writer is closed');
    this.pendingEvents.push(cloneJson(event));
    this.operation = this.operation
      .then(() => this.drain())
      .catch(() => {
        // Keep the unwritten suffix queued. flush() retries and surfaces persistent failures.
      });
  }

  private async ensureHandle() {
    if (this.handle) return;
    await mkdir(dirname(this.rolloutPath), { recursive: true });
    this.handle = await open(this.rolloutPath, 'a+', 0o600);
  }

  private async resetHandle() {
    if (this.handle) await this.handle.close().catch(() => {});
    this.handle = null;
  }

  private async appendEvent(event: YetSessionEvent) {
    await this.ensureHandle();
    const timestamp = new Date().toISOString();
    const line: YetRolloutLine = { timestamp, ordinal: this.nextOrdinal, ...event };
    await this.handle!.writeFile(`${JSON.stringify(line)}\n`, 'utf8');
    this.nextOrdinal += 1;
    this.metadata.lastOrdinal = line.ordinal;
    metadataFromEvent(this.metadata, event, timestamp);
    this.indexDirty = true;
  }

  private async recoverFailedAppend(event: YetSessionEvent, ordinal: number) {
    await this.resetHandle();
    const lines = await repairTrailingPartialLine(this.rolloutPath);
    const recovered = lines.find(line => line.ordinal === ordinal);
    if (recovered) {
      if (
        recovered.type !== event.type ||
        JSON.stringify(recovered.payload) !== JSON.stringify(event.payload)
      ) {
        throw new Error(`rollout ordinal ${ordinal} contains a different event`);
      }
      this.nextOrdinal = ordinal + 1;
      this.metadata.lastOrdinal = ordinal;
      metadataFromEvent(this.metadata, recovered, recovered.timestamp);
      this.indexDirty = true;
      return true;
    }

    const lastOrdinal = lines.at(-1)?.ordinal ?? -1;
    if (lastOrdinal + 1 !== ordinal)
      throw new Error(`rollout recovery expected ordinal ${ordinal}, found ${lastOrdinal}`);
    this.nextOrdinal = ordinal;
    return false;
  }

  private async writeWithRecovery(event: YetSessionEvent) {
    const ordinal = this.nextOrdinal;
    try {
      await this.appendEvent(event);
    } catch {
      if (await this.recoverFailedAppend(event, ordinal)) return;
      await this.appendEvent(event);
    }
  }

  private async drain() {
    if (this.pendingEvents.length === 0) return;
    if (this.pendingMeta) {
      await this.writeWithRecovery(this.pendingMeta);
      this.pendingMeta = null;
    }
    while (this.pendingEvents.length > 0) {
      await this.writeWithRecovery(this.pendingEvents[0]);
      this.pendingEvents.shift();
    }
    await this.flushIndex();
  }

  private async flushIndex() {
    if (!this.indexDirty) return;
    const entry: SessionIndexEntry = {
      ...this.metadata,
      rolloutPath: relative(this.yetHome, this.rolloutPath),
      rolloutBytes: statSync(this.rolloutPath).size,
    };
    try {
      await appendIndexEntry(entry, this.yetHome);
      this.indexDirty = false;
    } catch {
      await appendIndexEntry(entry, this.yetHome);
      this.indexDirty = false;
    }
  }

  async flush() {
    await this.operation;
    const barrier = this.drain().then(() => this.flushIndex());
    this.operation = barrier.catch(() => {});
    await barrier;
  }

  async close() {
    if (this.closed) return;
    try {
      await this.flush();
    } finally {
      this.closed = true;
      await this.resetHandle();
      await releaseSessionLock(this.lock);
    }
  }

  private async sealForLifecycleMutation() {
    if (this.closed) throw new Error('session writer is already closed');
    await this.flush();
    this.closed = true;
    await this.resetHandle();
  }

  async archiveSession() {
    await this.sealForLifecycleMutation();

    try {
      const sessionsRoot = resolve(this.yetHome, SESSION_DIRECTORY);
      const rolloutPath = resolve(this.rolloutPath);
      const relativePath = relative(sessionsRoot, rolloutPath);
      if (
        relativePath.startsWith('..') ||
        isAbsolute(relativePath) ||
        !basename(rolloutPath).includes(this.sessionId)
      ) {
        throw new Error(`refusing to archive rollout outside Yet sessions: ${this.rolloutPath}`);
      }

      const archiveRoot = join(this.yetHome, ARCHIVED_SESSION_DIRECTORY);
      const archivedPath = join(archiveRoot, basename(rolloutPath));
      await mkdir(archiveRoot, { recursive: true });
      if (existsSync(archivedPath))
        throw new Error(`an archived rollout already exists for session '${this.sessionId}'`);
      await rename(rolloutPath, archivedPath);

      const archivedAt = new Date().toISOString();
      const entry: SessionIndexEntry = {
        ...this.metadata,
        rolloutPath: relative(this.yetHome, archivedPath),
        rolloutBytes: statSync(archivedPath).size,
        archivedAt,
      };
      await appendIndexEntry(entry, this.yetHome).catch(() => {});
      return archivedPath;
    } finally {
      await releaseSessionLock(this.lock);
    }
  }

  async deleteSession() {
    await this.sealForLifecycleMutation();

    try {
      const sessionsRoot = resolve(this.yetHome, SESSION_DIRECTORY);
      const rolloutPath = resolve(this.rolloutPath);
      const relativePath = relative(sessionsRoot, rolloutPath);
      if (
        relativePath.startsWith('..') ||
        isAbsolute(relativePath) ||
        !basename(rolloutPath).includes(this.sessionId)
      ) {
        throw new Error(`refusing to delete rollout outside Yet sessions: ${this.rolloutPath}`);
      }

      try {
        await unlink(rolloutPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await removeIndexEntry(this.sessionId, this.yetHome).catch(() => {});
    } finally {
      await releaseSessionLock(this.lock);
    }
  }
}

export async function loadYetSession(
  sessionId: string,
  options: { yetHome?: string; includeArchived?: boolean } = {},
): Promise<LoadedYetSession | null> {
  const yetHome = options.yetHome ?? DEFAULT_YET_HOME;
  const entries = await readIndex(yetHome);
  const entry = entries.get(sessionId);
  if (entry && (options.includeArchived || !entry.archivedAt)) {
    const path = rolloutPathFromIndex(entry, yetHome);
    if (path) {
      try {
        const loaded = loadedSessionFromLines(await readYetRollout(path), path);
        if (loaded?.sessionId === sessionId) {
          if (entry.archivedAt) loaded.archivedAt = entry.archivedAt;
          return loaded;
        }
      } catch {}
    }
  }

  for (const path of await findRolloutPaths(join(yetHome, SESSION_DIRECTORY))) {
    if (!basename(path).includes(sessionId)) continue;
    try {
      const loaded = loadedSessionFromLines(await readYetRollout(path), path);
      if (loaded?.sessionId === sessionId) return loaded;
    } catch {}
  }
  return null;
}

export async function restoreYetSession(
  sessionId: string,
  options: { yetHome?: string } = {},
): Promise<LoadedYetSession | null> {
  const yetHome = options.yetHome ?? DEFAULT_YET_HOME;
  const entries = await readIndex(yetHome);
  const entry = entries.get(sessionId);
  if (!entry?.archivedAt) return loadYetSession(sessionId, { yetHome });

  const archivedPath = rolloutPathFromIndex(entry, yetHome);
  if (!archivedPath) throw new Error(`invalid archived rollout path for session '${sessionId}'`);
  const archiveRoot = resolve(yetHome, ARCHIVED_SESSION_DIRECTORY);
  const resolvedArchivedPath = resolve(archivedPath);
  const archivedRelativePath = relative(archiveRoot, resolvedArchivedPath);
  if (
    archivedRelativePath.startsWith('..') ||
    isAbsolute(archivedRelativePath) ||
    !basename(resolvedArchivedPath).includes(sessionId)
  ) {
    throw new Error(`refusing to restore rollout outside Yet archives: ${archivedPath}`);
  }

  const restoredPath = newRolloutPath(sessionId, entry.createdAt, yetHome);
  const lock = await acquireSessionLock(sessionId, yetHome);
  try {
    await mkdir(dirname(restoredPath), { recursive: true });
    if (existsSync(restoredPath))
      throw new Error(`an active rollout already exists for session '${sessionId}'`);
    await rename(resolvedArchivedPath, restoredPath);

    const { archivedAt: _archivedAt, ...activeMetadata } = entry;
    await appendIndexEntry(
      {
        ...activeMetadata,
        rolloutPath: relative(yetHome, restoredPath),
        rolloutBytes: statSync(restoredPath).size,
      },
      yetHome,
    ).catch(() => {});
  } finally {
    await releaseSessionLock(lock);
  }

  if (!entry.rootSessionId) {
    for (const child of entries.values()) {
      if (child.rootSessionId === sessionId && child.archivedAt) {
        await restoreYetSession(child.sessionId, { yetHome });
      }
    }
    const { restoreAgentGraph } = await import('./collaboration/graph-store');
    await restoreAgentGraph(sessionId, yetHome);
  }

  return loadYetSession(sessionId, { yetHome });
}
