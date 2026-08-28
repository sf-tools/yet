import type { AgentMessage, AgentUsage } from './messages';
import {
  COMPACTION_PROMPT,
  COMPACTION_SUMMARY_PREFIX,
  COMPACTION_RECENT_MESSAGE_COUNT,
  MODEL,
  type ThinkingMode,
} from '@/config';
import { generateOpenAIText } from '@/providers/openai';
import { plain } from '@/text';

export type CompactMessagesOptions = {
  recentMessageCount?: number;
  force?: boolean;
  model?: string;
  thinkingMode?: ThinkingMode;
  fastModeEnabled?: boolean;
};

export type CompactionResult = {
  summary: string;
  messages: AgentMessage[];
  previousMessageCount: number;
  nextMessageCount: number;
  usage: AgentUsage;
};

function extractSummary(text: string) {
  const normalized = plain(text).trim();
  const match = normalized.match(/<summary[^>]*>([\s\S]*?)<\/summary>/i);
  const summary = (match?.[1] ?? normalized).trim();
  if (!summary) throw new Error('empty compaction summary');
  return summary;
}

function getSystemMessages(messages: AgentMessage[]) {
  return messages.filter(message => message.role === 'system');
}

function getConversationMessages(messages: AgentMessage[]) {
  return messages.filter(message => message.role !== 'system');
}

function resolveTailCount(messages: AgentMessage[], recentMessageCount: number, force: boolean) {
  if (!force) return recentMessageCount;
  return Math.min(recentMessageCount, Math.max(0, messages.length - 1));
}

function messageTokenCount(message: AgentMessage) {
  try {
    return Math.max(1, Math.ceil(JSON.stringify('content' in message ? message.content : message).length / 4));
  } catch {
    return 1;
  }
}

function retainedUserMessages(messages: AgentMessage[], maxTokens = 20_000) {
  const selected: AgentMessage[] = [];
  let remaining = maxTokens;
  for (const message of messages.slice().reverse()) {
    if (message.role !== 'user') continue;
    if (typeof message.content === 'string' && message.content.startsWith(COMPACTION_SUMMARY_PREFIX))
      continue;
    const tokens = messageTokenCount(message);
    if (tokens > remaining) continue;
    selected.push(message);
    remaining -= tokens;
    if (remaining <= 0) break;
  }
  return selected.reverse();
}

export function canCompactMessages(
  messages: AgentMessage[],
  recentMessageCount = COMPACTION_RECENT_MESSAGE_COUNT,
  force = false,
) {
  const conversation = getConversationMessages(messages);
  return conversation.length > resolveTailCount(conversation, recentMessageCount, force);
}

export async function compactMessages(
  messages: AgentMessage[],
  options: CompactMessagesOptions = {},
): Promise<CompactionResult> {
  const {
    recentMessageCount = COMPACTION_RECENT_MESSAGE_COUNT,
    force = false,
    model = MODEL,
    thinkingMode = 'auto',
    fastModeEnabled = false,
  } = options;
  const systemMessages = getSystemMessages(messages);
  const conversationMessages = getConversationMessages(messages);
  const tailCount = resolveTailCount(conversationMessages, recentMessageCount, force);
  if (conversationMessages.length <= tailCount)
    throw new Error('not enough conversation history to compact');

  const result = await generateOpenAIText({
    model,
    thinkingMode,
    fastModeEnabled,
    messages: [
      ...messages,
      { role: 'user', content: COMPACTION_PROMPT },
    ],
  });
  const summary = extractSummary(result.text);
  const compactedMessages: AgentMessage[] = [
    ...systemMessages,
    ...retainedUserMessages(conversationMessages),
    { role: 'user', content: `${COMPACTION_SUMMARY_PREFIX}\n${summary}` },
  ];

  return {
    summary,
    messages: compactedMessages,
    previousMessageCount: messages.length,
    nextMessageCount: compactedMessages.length,
    usage: result.usage,
  };
}
