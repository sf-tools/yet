import OpenAI from 'openai';
import type {
  EasyInputMessage,
  FunctionTool,
  Response,
  ResponseInputItem,
  ResponseStreamEvent,
} from 'openai/resources/responses/responses';

import type { AgentChatMessage, AgentContent, AgentMessage, AgentUsage } from '@/agent/messages';
import { EMPTY_USAGE } from '@/agent/messages';
import {
  getOpenAIProviderModelId,
  type ThinkingMode,
} from '@/config';
import type { Tool } from '@/tools';

export type ProviderToolCall = {
  id: string;
  name: string;
  input: unknown;
};

export type ProviderToolOutput = {
  callId: string;
  output: string;
};

export type ProviderEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; text: string };

export type OpenAIResponseStep = {
  responseId: string;
  text: string;
  reasoning: string;
  toolCalls: ProviderToolCall[];
  usage: AgentUsage;
};

type StreamStepOptions = {
  model: string;
  thinkingMode: ThinkingMode;
  messages: AgentMessage[];
  tools: Tool[];
  previousResponseId?: string;
  toolOutputs?: ProviderToolOutput[];
  signal?: AbortSignal;
  onEvent?: (event: ProviderEvent) => void;
};

let client: OpenAI | null = null;

function getClient() {
  if (!process.env.OPENAI_API_KEY)
    throw new Error('OPENAI_API_KEY is required. Set it in the environment before starting Yet.');
  client ??= new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return client;
}

function textFromContent(content: AgentContent) {
  if (typeof content === 'string') return content;
  return content
    .filter(part => part.type === 'text')
    .map(part => part.text)
    .join('\n');
}

function messageInput(message: AgentChatMessage): EasyInputMessage {
  if (typeof message.content === 'string') return { role: message.role, content: message.content };

  return {
    role: message.role,
    content: message.content.map(part =>
      part.type === 'text'
        ? ({ type: 'input_text', text: part.text } as const)
        : ({ type: 'input_image', image_url: part.dataUrl, detail: 'auto' } as const),
    ),
  };
}

function splitInstructions(messages: AgentMessage[]) {
  const instructions = messages
    .filter(
      (message): message is AgentChatMessage =>
        'content' in message && message.role === 'system',
    )
    .map(message => textFromContent(message.content))
    .filter(Boolean)
    .join('\n\n');
  const input: ResponseInputItem[] = messages
    .filter(message => message.role !== 'system')
    .map(message => {
      if (message.role === 'tool-call') {
        return {
          type: 'function_call',
          call_id: message.callId,
          name: message.name,
          arguments: JSON.stringify(message.input),
        };
      }
      if (message.role === 'tool-result') {
        return {
          type: 'function_call_output',
          call_id: message.callId,
          output: message.output,
        };
      }
      return messageInput(message);
    });
  return { instructions: instructions || undefined, input };
}

function functionTool(tool: Tool): FunctionTool {
  return {
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    strict: false,
  };
}

function reasoning(thinkingMode: ThinkingMode) {
  return {
    summary: 'auto' as const,
    ...(thinkingMode === 'auto' ? {} : { effort: thinkingMode }),
  };
}

function usageFromResponse(response: Response): AgentUsage {
  const usage = response.usage;
  if (!usage) return EMPTY_USAGE;
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    reasoningTokens: usage.output_tokens_details.reasoning_tokens,
    cachedInputTokens: usage.input_tokens_details.cached_tokens,
  };
}

function errorFromEvent(event: ResponseStreamEvent) {
  if (event.type === 'error') return event.message;
  if (event.type === 'response.failed')
    return event.response.error?.message ?? 'OpenAI response failed';
  if (event.type === 'response.incomplete')
    return `OpenAI response incomplete: ${event.response.incomplete_details?.reason ?? 'unknown reason'}`;
  return null;
}

export async function streamOpenAIResponse(options: StreamStepOptions): Promise<OpenAIResponseStep> {
  const { instructions, input: messageItems } = splitInstructions(options.messages);
  const toolOutputItems: ResponseInputItem[] = (options.toolOutputs ?? []).map(output => ({
    type: 'function_call_output',
    call_id: output.callId,
    output: output.output,
  }));
  const input: ResponseInputItem[] = options.previousResponseId ? toolOutputItems : messageItems;
  const stream = await getClient().responses.create(
    {
      model: getOpenAIProviderModelId(options.model),
      instructions,
      input,
      tools: options.tools.map(functionTool),
      parallel_tool_calls: false,
      reasoning: reasoning(options.thinkingMode),
      store: true,
      stream: true,
      ...(options.previousResponseId
        ? { previous_response_id: options.previousResponseId }
        : {}),
    },
    { signal: options.signal },
  );

  let text = '';
  let reasoningText = '';
  let completed: Response | null = null;
  const toolCalls: ProviderToolCall[] = [];

  for await (const event of stream) {
    const failure = errorFromEvent(event);
    if (failure) throw new Error(failure);

    if (event.type === 'response.output_text.delta') {
      text += event.delta;
      options.onEvent?.({ type: 'text-delta', text: event.delta });
      continue;
    }

    if (event.type === 'response.reasoning_summary_text.delta') {
      reasoningText += event.delta;
      options.onEvent?.({ type: 'reasoning-delta', text: event.delta });
      continue;
    }

    if (event.type === 'response.output_item.done' && event.item.type === 'function_call') {
      let inputValue: unknown;
      try {
        inputValue = JSON.parse(event.item.arguments);
      } catch {
        throw new Error(`tool ${event.item.name} returned invalid JSON arguments`);
      }
      toolCalls.push({ id: event.item.call_id, name: event.item.name, input: inputValue });
      continue;
    }

    if (event.type === 'response.completed') completed = event.response;
  }

  if (!completed) throw new Error('OpenAI stream ended without a completed response');

  return {
    responseId: completed.id,
    text,
    reasoning: reasoningText,
    toolCalls,
    usage: usageFromResponse(completed),
  };
}

export async function generateOpenAIText(options: {
  model: string;
  thinkingMode: ThinkingMode;
  messages: AgentMessage[];
  signal?: AbortSignal;
}) {
  const step = await streamOpenAIResponse({ ...options, tools: [] });
  return { text: step.text, usage: step.usage, responseId: step.responseId };
}
