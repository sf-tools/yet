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
import { createInitialState } from '@/store/state';
import type { AgentState } from '@/store/types';
import { EntryKind, type HistoryEntry, type ToolHistoryEntry } from '@/types';

type PersistedSessionState = {
  messages: AgentState['messages'];
  historyEntries: AgentState['historyEntries'];
  inputChars: string[];
  cursor: number;
  totalCost: number;
  currentModel: string;
  thinkingMode: AgentState['thinkingMode'];
  fastModeEnabled: boolean;
  permissionMode: AgentState['permissionMode'];
  autoCompactEnabled: boolean;
  planningMode: boolean;
  showThinking: boolean;
};

export type YetSessionListEntry = {
  sessionId: string;
  cwd: string;
  savedAt: string;
  title?: string;
  preview?: string;
  rolloutPath?: string;
};

export type LoadedYetSession = {
  version: 2;
  sessionId: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  name?: string;
  rolloutPath: string;
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
};

export type YetSessionEvent =
  | {
      type: 'session_meta';
      payload: { version: 2; sessionId: string; cwd: string; createdAt: string };
    }
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
      payload: { usage: AgentUsage; totalCost: number };
    }
  | {
      type: 'compacted';
      payload: {
        messages: AgentMessage[];
        entry: Extract<HistoryEntry, { type: 'compacted' }>;
        usage: AgentUsage;
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
};

type SessionMetadata = Omit<SessionIndexEntry, 'rolloutPath'>;

const DEFAULT_YET_HOME = join(homedir(), '.yet');
const SESSION_INDEX_FILE = 'session_index.jsonl';
const SESSION_DIRECTORY = 'sessions';
const LOCK_DIRECTORY = 'locks';

function normalizeWhitespace(text: string) {
  return text.replace(/\s+/g, ' ').trim();
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function persistedStateFromAgentState(
  state: AgentState,
  keepDraft = false,
): PersistedSessionState {
  return {
    messages: cloneJson(state.messages),
    historyEntries: cloneJson(state.historyEntries),
    inputChars: keepDraft ? [...state.inputChars] : [],
    cursor: keepDraft ? state.cursor : 0,
    totalCost: state.totalCost,
    currentModel: state.currentModel,
    thinkingMode: state.thinkingMode,
    fastModeEnabled: state.fastModeEnabled,
    permissionMode: state.permissionMode,
    autoCompactEnabled: state.autoCompactEnabled,
    planningMode: state.planningMode,
    showThinking: state.showThinking,
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

function hydratePersistedState(persisted: PersistedSessionState): AgentState {
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
    thinkingMode: persisted.thinkingMode,
    totalCost: persisted.totalCost,
  };
}

export function hydrateStateFromSession(session: LoadedYetSession): AgentState {
  return hydratePersistedState(session.state);
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

function setUsage(state: AgentState, usage: AgentUsage) {
  state.lastPromptTokens = usage.inputTokens;
  state.lastOutputTokens = usage.outputTokens;
  state.lastReasoningTokens = usage.reasoningTokens;
}

function applyEvent(state: AgentState, event: YetSessionEvent) {
  switch (event.type) {
    case 'session_meta':
    case 'thread_name_updated':
      break;
    case 'turn_context':
      state.currentModel = event.payload.model;
      state.thinkingMode = event.payload.thinkingMode;
      state.fastModeEnabled = event.payload.fastModeEnabled ?? false;
      state.permissionMode = event.payload.permissionMode;
      state.autoCompactEnabled = event.payload.autoCompactEnabled;
      state.planningMode = event.payload.planningMode;
      state.showThinking = event.payload.showThinking;
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
      setUsage(state, event.payload.usage);
      state.totalCost = event.payload.totalCost;
      break;
    case 'compacted':
      state.messages.splice(0, state.messages.length, ...event.payload.messages);
      state.historyEntries.push(event.payload.entry);
      setUsage(state, event.payload.usage);
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
  for (const path of await findRolloutPaths(join(yetHome, SESSION_DIRECTORY))) {
    try {
      const existing = indexedPaths.get(resolve(path));
      const rolloutBytes = statSync(path).size;
      if (existing?.rolloutBytes === rolloutBytes) continue;
      const lines = await readYetRollout(path);
      const loaded = loadedSessionFromLines(lines, path);
      if (!loaded) continue;
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
  for (const path of findRolloutPathsSync(join(yetHome, SESSION_DIRECTORY))) {
    try {
      const existing = indexedPaths.get(resolve(path));
      const rolloutBytes = statSync(path).size;
      if (existing?.rolloutBytes === rolloutBytes) continue;
      const lines = readYetRolloutSync(path);
      const loaded = loadedSessionFromLines(lines, path);
      if (!loaded) continue;
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
        savedAt: entry.updatedAt,
        ...(entry.name ? { title: entry.name } : {}),
        ...(entry.preview ? { preview: entry.preview } : {}),
        rolloutPath: path,
      } satisfies YetSessionListEntry,
    ];
  });
}

function filterAndSortEntries(entries: YetSessionListEntry[], cwd?: string) {
  const targetCwd = cwd ? resolve(cwd) : null;
  return entries
    .filter(entry => !targetCwd || resolve(entry.cwd) === targetCwd)
    .sort((left, right) => Date.parse(right.savedAt) - Date.parse(left.savedAt));
}

export async function listYetSessions(
  options: { cwd?: string; yetHome?: string } = {},
): Promise<YetSessionListEntry[]> {
  const yetHome = options.yetHome ?? DEFAULT_YET_HOME;
  return filterAndSortEntries(
    listEntriesFromIndex(await readIndex(yetHome), yetHome),
    options.cwd,
  );
}

export function listYetSessionsSync(
  options: { cwd?: string; yetHome?: string } = {},
): YetSessionListEntry[] {
  const yetHome = options.yetHome ?? DEFAULT_YET_HOME;
  return filterAndSortEntries(
    listEntriesFromIndex(readIndexSync(yetHome), yetHome),
    options.cwd,
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
          },
        };
    this.metadata = {
      sessionId: options.sessionId,
      cwd: options.cwd,
      createdAt: options.createdAt,
      updatedAt: options.lines.at(-1)?.timestamp ?? options.createdAt,
      ...(options.title ? { name: options.title } : {}),
      lastOrdinal: this.nextOrdinal - 1,
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
      });
    } catch (error) {
      await releaseSessionLock(lock);
      throw error;
    }
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

  async deleteSession() {
    await this.close();

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
    await removeIndexEntry(this.sessionId, this.yetHome);
  }
}

export async function loadYetSession(
  sessionId: string,
  options: { yetHome?: string } = {},
): Promise<LoadedYetSession | null> {
  const yetHome = options.yetHome ?? DEFAULT_YET_HOME;
  const entries = await readIndex(yetHome);
  const entry = entries.get(sessionId);
  if (entry) {
    const path = rolloutPathFromIndex(entry, yetHome);
    if (path) {
      try {
        const loaded = loadedSessionFromLines(await readYetRollout(path), path);
        if (loaded?.sessionId === sessionId) return loaded;
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
