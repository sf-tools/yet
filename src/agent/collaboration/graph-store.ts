import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import type { AgentGraphEvent } from './control';
import type { PersistedRegisteredAgent } from './registry';

type StoredAgentGraphEvent = AgentGraphEvent & {
  id: string;
  rootId: string;
  timestamp: string;
};

function graphDirectory(yetHome: string) {
  return join(yetHome, 'agent_graphs');
}

export function agentGraphPath(rootId: string, yetHome = join(homedir(), '.yet')) {
  return join(graphDirectory(yetHome), `${rootId}.jsonl`);
}

export async function restoreAgentGraph(rootId: string, yetHome = join(homedir(), '.yet')) {
  const path = agentGraphPath(rootId, yetHome);
  try {
    await rename(`${path}.archived`, path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw error;
  }
  return path;
}

function parseEvents(raw: string) {
  const events: StoredAgentGraphEvent[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as StoredAgentGraphEvent;
      if (event && typeof event.id === 'string' && typeof event.type === 'string') events.push(event);
    } catch {
      // A partial final append is ignored; the preceding JSONL records remain canonical.
    }
  }
  return events;
}

export class AgentGraphStore {
  readonly path: string;
  private operation = Promise.resolve();

  constructor(readonly rootId: string, options: { yetHome?: string } = {}) {
    this.path = agentGraphPath(rootId, options.yetHome);
  }

  async load() {
    let events: StoredAgentGraphEvent[] = [];
    try {
      events = parseEvents(await readFile(this.path, 'utf8'));
    } catch {}
    const agents = new Map<string, PersistedRegisteredAgent>();
    for (const event of events) {
      if (event.type === 'agent_upsert') {
        agents.set(event.agent.id, structuredClone(event.agent));
        continue;
      }
      if (event.type === 'agent_removed') {
        agents.delete(event.agentId);
        continue;
      }
      const agent = agents.get(event.agentId);
      if (!agent) continue;
      const removed = new Set(event.envelopeIds);
      agent.mailbox = agent.mailbox.filter(envelope => !removed.has(envelope.id));
    }
    return [...agents.values()].sort((left, right) => left.spawnOrder - right.spawnOrder);
  }

  append(event: AgentGraphEvent) {
    const record: StoredAgentGraphEvent = {
      ...structuredClone(event),
      id: randomUUID(),
      rootId: this.rootId,
      timestamp: new Date().toISOString(),
    };
    const write = async () => {
      await mkdir(dirname(this.path), { recursive: true });
      await appendFile(this.path, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
    };
    this.operation = this.operation.then(write, write);
    return this.operation;
  }

  async flush() {
    await this.operation;
  }

  async archive() {
    await this.flush();
    const archived = `${this.path}.archived`;
    try {
      await rename(this.path, archived);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return archived;
  }

  async delete() {
    await this.flush();
    await unlink(this.path).catch(() => {});
    await unlink(`${this.path}.archived`).catch(() => {});
  }
}
