import type { AgentMessage, AgentUsage } from './messages';
import {
  COMPACTION_PROMPT,
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
  const tail = conversationMessages.slice(-tailCount);
  const messagesToSummarize = conversationMessages.slice(
    0,
    Math.max(0, conversationMessages.length - tail.length),
  );
  if (messagesToSummarize.length === 0)
    throw new Error('not enough conversation history to compact');

  const result = await generateOpenAIText({
    model,
    thinkingMode,
    fastModeEnabled,
    messages: [
      ...systemMessages,
      ...messagesToSummarize,
      { role: 'user', content: COMPACTION_PROMPT },
    ],
  });
  const summary = extractSummary(result.text);
  const compactedMessages: AgentMessage[] = [
    ...systemMessages,
    { role: 'assistant', content: `<summary>\n${summary}\n</summary>` },
    ...tail,
  ];

  return {
    summary,
    messages: compactedMessages,
    previousMessageCount: messages.length,
    nextMessageCount: compactedMessages.length,
    usage: result.usage,
  };
}
