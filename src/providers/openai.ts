import OpenAI from 'openai';
import type {
  EasyInputMessage,
  FunctionTool,
  NamespaceTool,
  Response,
  ResponseInputItem,
  ResponseStreamEvent,
  ResponseTextConfig,
} from 'openai/resources/responses/responses';

import type { AgentChatMessage, AgentContent, AgentMessage, AgentUsage } from '@/agent/messages';
import { EMPTY_USAGE } from '@/agent/messages';
import { resolveOpenAIConnection } from '@/auth';
import {
  getOpenAIProviderModelId,
  type ThinkingMode,
} from '@/config';
import type { Tool } from '@/tools';

export type ProviderToolCall = {
  id: string;
  name: string;
  namespace?: string;
  input: unknown;
};

export type ProviderToolOutput = {
  callId: string;
  namespace?: string;
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
  fastModeEnabled?: boolean;
  messages: AgentMessage[];
  tools: Tool[];
  previousResponseId?: string;
  toolOutputs?: ProviderToolOutput[];
  continuationMessages?: AgentChatMessage[];
  signal?: AbortSignal;
  text?: ResponseTextConfig;
  store?: boolean;
  onEvent?: (event: ProviderEvent) => void;
};

let client: OpenAI | null = null;
let clientCacheKey: string | null = null;

async function getClient() {
  const connection = await resolveOpenAIConnection();
  if (!client || clientCacheKey !== connection.cacheKey) {
    client = new OpenAI({
      apiKey: connection.apiKey,
      ...(connection.baseURL ? { baseURL: connection.baseURL } : {}),
      ...(connection.defaultHeaders ? { defaultHeaders: connection.defaultHeaders } : {}),
    });
    clientCacheKey = connection.cacheKey;
  }
  return client;
}

export function resetOpenAIClient() {
  client = null;
  clientCacheKey = null;
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
          ...(message.namespace ? { namespace: message.namespace } : {}),
          arguments: JSON.stringify(message.input),
        };
      }
      if (message.role === 'tool-result') {
        return {
          type: 'function_call_output',
          call_id: message.callId,
          ...(message.namespace ? { namespace: message.namespace } : {}),
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
    ...(tool.outputSchema ? { output_schema: tool.outputSchema } : {}),
  };
}

export function serializeOpenAIResponseTools(tools: Tool[]): Array<FunctionTool | NamespaceTool> {
  const direct = tools.filter(tool => !tool.namespace).map(functionTool);
  const namespaces = new Map<string, Tool[]>();
  for (const tool of tools) {
    if (!tool.namespace) continue;
    const grouped = namespaces.get(tool.namespace) ?? [];
    grouped.push(tool);
    namespaces.set(tool.namespace, grouped);
  }
  return [
    ...direct,
    ...[...namespaces].map(([name, grouped]) => ({
      type: 'namespace' as const,
      name,
      description: grouped[0]?.namespaceDescription ?? `Tools in the ${name} namespace.`,
      tools: grouped.map(functionTool),
    })),
  ];
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
    ...(output.namespace ? { namespace: output.namespace } : {}),
    output: output.output,
  }));
  const continuationItems: ResponseInputItem[] = (options.continuationMessages ?? []).map(
    messageInput,
  );
  const input: ResponseInputItem[] = options.previousResponseId
    ? [...toolOutputItems, ...continuationItems]
    : messageItems;
  const openai = await getClient();
  const stream = await openai.responses.create(
    {
      model: getOpenAIProviderModelId(options.model),
      instructions,
      input,
      tools: serializeOpenAIResponseTools(options.tools),
      parallel_tool_calls: false,
      reasoning: reasoning(options.thinkingMode),
      ...(options.fastModeEnabled ? { service_tier: 'priority' as const } : {}),
      store: options.store ?? true,
      stream: true,
      ...(options.text ? { text: options.text } : {}),
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
      toolCalls.push({
        id: event.item.call_id,
        name: event.item.name,
        ...(event.item.namespace ? { namespace: event.item.namespace } : {}),
        input: inputValue,
      });
      continue;
    }

    if (event.type === 'response.completed') completed = event.response;
  }

  if (!completed && options.signal?.aborted) {
    return {
      responseId: '',
      text,
      reasoning: reasoningText,
      toolCalls,
      usage: EMPTY_USAGE,
    };
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
  fastModeEnabled?: boolean;
  messages: AgentMessage[];
  signal?: AbortSignal;
  text?: ResponseTextConfig;
  store?: boolean;
}) {
  const step = await streamOpenAIResponse({ ...options, tools: [] });
  return { text: step.text, usage: step.usage, responseId: step.responseId };
}
