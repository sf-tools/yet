export type AgentTextPart = {
  type: 'text';
  text: string;
};

export type AgentImagePart = {
  type: 'image';
  dataUrl: string;
};

export type AgentContent = string | Array<AgentTextPart | AgentImagePart>;

export type AgentChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: AgentContent;
  phase?: 'commentary' | 'final_answer';
  interAgent?: { triggerTurn: boolean };
};

export type AgentToolCallMessage = {
  role: 'tool-call';
  callId: string;
  name: string;
  namespace?: string;
  input: unknown;
};

export type AgentToolResultMessage = {
  role: 'tool-result';
  callId: string;
  namespace?: string;
  output: string;
};

export type AgentMessage = AgentChatMessage | AgentToolCallMessage | AgentToolResultMessage;

function textFromContent(content: AgentContent) {
  if (typeof content === 'string') return content.trim();
  return content
    .filter(part => part.type === 'text')
    .map(part => part.text)
    .join('\n')
    .trim();
}

export function getLastAssistantResponse(messages: AgentMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'assistant') continue;

    const text = textFromContent(message.content);
    if (text && !text.startsWith('<summary>')) return text;
  }
  return null;
}

export type AgentUsage = {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedInputTokens: number;
};

export const EMPTY_USAGE: AgentUsage = {
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cachedInputTokens: 0,
};

export function addUsage(left: AgentUsage, right: AgentUsage): AgentUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
  };
}
