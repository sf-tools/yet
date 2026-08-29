import type { AgentMessage } from '@/agent/messages';

export type ForkTurns = 'none' | 'all' | number;

export function parseForkTurns(value: unknown): ForkTurns {
  if (value === undefined || value === null || value === '') return 'all';
  if (typeof value !== 'string') {
    throw new Error('fork_turns must be `none`, `all`, or a positive integer string');
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'none' || normalized === 'all') return normalized;
  if (!/^\d+$/.test(normalized) || Number(normalized) <= 0) {
    throw new Error('fork_turns must be `none`, `all`, or a positive integer string');
  }
  return Number(normalized);
}

function isInterAgentMessage(message: AgentMessage) {
  return message.role === 'user' && (
    message.interAgent !== undefined ||
    typeof message.content === 'string' &&
      /^Message Type: (?:NEW_TASK|MESSAGE|FINAL_ANSWER)\n/.test(message.content)
  );
}

function isForkTurnBoundary(message: AgentMessage) {
  if (message.role !== 'user') return false;
  if (!isInterAgentMessage(message)) return true;
  return message.interAgent?.triggerTurn ?? /^Message Type: NEW_TASK\n/.test(String(message.content));
}

function isFinalAssistant(messages: AgentMessage[], index: number) {
  const message = messages[index];
  if (message?.role !== 'assistant') return false;
  if (message.phase) return message.phase === 'final_answer';
  for (let cursor = index + 1; cursor < messages.length; cursor += 1) {
    const next = messages[cursor];
    if (next.role === 'tool-call') return false;
    if (next.role === 'assistant' || next.role === 'user' || next.role === 'system') break;
  }
  return true;
}

function sanitizeForkedMessages(messages: AgentMessage[]) {
  return messages.filter((message, index) => {
    if (message.role === 'system') return true;
    if (message.role === 'user') return !isInterAgentMessage(message);
    if (message.role === 'assistant') return isFinalAssistant(messages, index);
    return false;
  });
}

export function forkAgentMessages(messages: AgentMessage[], forkTurns: ForkTurns) {
  const system = messages.filter(message => message.role === 'system');
  if (forkTurns === 'none') return system.map(message => structuredClone(message));

  const history = messages.filter(message => message.role !== 'system');
  const selected = (() => {
    if (forkTurns === 'all') return history;
    const userIndexes = history.flatMap((message, index) => isForkTurnBoundary(message) ? [index] : []);
    const start = userIndexes[Math.max(0, userIndexes.length - forkTurns)] ?? history.length;
    return history.slice(start);
  })();

  return sanitizeForkedMessages([...system, ...selected]).map(message => structuredClone(message));
}

export function validateSpawnOverrides(options: {
  forkTurns: ForkTurns;
  model?: string;
  reasoningEffort?: string;
}) {
  if (options.forkTurns !== 'all') return;
  if (options.model !== undefined || options.reasoningEffort !== undefined) {
    throw new Error('full-history forks inherit the parent model and reasoning effort and do not accept overrides');
  }
}
