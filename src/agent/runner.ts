import {
  addUsage,
  EMPTY_USAGE,
  type AgentChatMessage,
  type AgentMessage,
  type AgentToolCallMessage,
  type AgentToolResultMessage,
  type AgentUsage,
} from './messages';
import {
  streamOpenAIResponse,
  type ProviderToolCall,
  type ProviderToolOutput,
} from '@/providers/openai';
import type { ThinkingMode } from '@/config';
import type { ToolExecutionResult, ToolRegistry } from '@/tools';

export type AgentLoopEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; text: string }
  | { type: 'tool-call'; call: ProviderToolCall; message: AgentToolCallMessage }
  | {
      type: 'tool-result';
      call: ProviderToolCall;
      result: ToolExecutionResult;
      message: AgentToolResultMessage;
    }
  | {
      type: 'tool-error';
      call: ProviderToolCall;
      error: unknown;
      message: AgentToolResultMessage;
    }
  | { type: 'step-completed'; usage: AgentUsage; message?: AgentChatMessage };

export type RunAgentLoopOptions = {
  model: string;
  thinkingMode: ThinkingMode;
  fastModeEnabled?: boolean;
  messages: AgentMessage[];
  tools: ToolRegistry;
  signal?: AbortSignal;
  onEvent?: (event: AgentLoopEvent) => void | Promise<void>;
  takeSteers?: (signal?: AbortSignal) => Promise<AgentMessage[]>;
};

export type AgentLoopResult = {
  responseId: string;
  text: string;
  reasoning: string;
  usage: AgentUsage;
  messages: AgentMessage[];
};

function toolOutput(value: unknown) {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export async function runAgentLoop(options: RunAgentLoopOptions): Promise<AgentLoopResult> {
  let previousResponseId: string | undefined;
  let pendingOutputs: ProviderToolOutput[] | undefined;
  let continuationMessages: AgentChatMessage[] | undefined;
  let accumulatedText = '';
  let accumulatedReasoning = '';
  let accumulatedUsage = EMPTY_USAGE;
  const generatedMessages: AgentMessage[] = [];
  const runtimeMessages = [...options.messages];

  const takeSteers = async () => {
    options.signal?.throwIfAborted();
    const messages = (await options.takeSteers?.(options.signal)) ?? [];
    options.signal?.throwIfAborted();
    if (messages.length === 0) return [];

    generatedMessages.push(...messages);
    runtimeMessages.push(...messages);
    return messages.filter(
      (message): message is AgentChatMessage =>
        'content' in message && message.role !== 'system',
    );
  };

  while (true) {
    options.signal?.throwIfAborted();
    const step = await streamOpenAIResponse({
      model: options.model,
      thinkingMode: options.thinkingMode,
      fastModeEnabled: options.fastModeEnabled,
      messages: runtimeMessages,
      tools: options.tools.list(),
      previousResponseId,
      toolOutputs: pendingOutputs,
      continuationMessages,
      signal: options.signal,
      onEvent: event => options.onEvent?.(event),
    });
    options.signal?.throwIfAborted();

    previousResponseId = step.responseId;
    accumulatedText += step.text;
    accumulatedReasoning += step.reasoning;
    accumulatedUsage = addUsage(accumulatedUsage, step.usage);
    const assistantMessage: AgentChatMessage | undefined = step.text.trim()
      ? {
          role: 'assistant',
          content: step.text,
          phase: step.toolCalls.length === 0 ? 'final_answer' : 'commentary',
        }
      : undefined;
    if (assistantMessage) generatedMessages.push(assistantMessage);
    await options.onEvent?.({
      type: 'step-completed',
      usage: step.usage,
      ...(assistantMessage ? { message: assistantMessage } : {}),
    });

    if (step.toolCalls.length === 0) {
      continuationMessages = await takeSteers();
      if (continuationMessages.length > 0) {
        pendingOutputs = undefined;
        continue;
      }

      return {
        responseId: step.responseId,
        text: accumulatedText,
        reasoning: accumulatedReasoning,
        usage: accumulatedUsage,
        messages: generatedMessages,
      };
    }

    pendingOutputs = [];
    continuationMessages = undefined;
    for (const call of step.toolCalls) {
      const callMessage: AgentToolCallMessage = {
        role: 'tool-call',
        callId: call.id,
        name: call.name,
        ...(call.namespace ? { namespace: call.namespace } : {}),
        input: call.input,
      };
      generatedMessages.push(callMessage);
      await options.onEvent?.({ type: 'tool-call', call, message: callMessage });
      try {
        const result = await options.tools.execute(call.name, call.input, call.namespace);
        const output = JSON.stringify({ ok: true, output: toolOutput(result.output) });
        pendingOutputs.push({
          callId: call.id,
          ...(call.namespace ? { namespace: call.namespace } : {}),
          output,
        });
        const resultMessage: AgentToolResultMessage = {
          role: 'tool-result',
          callId: call.id,
          ...(call.namespace ? { namespace: call.namespace } : {}),
          output,
        };
        generatedMessages.push(resultMessage);
        await options.onEvent?.({ type: 'tool-result', call, result, message: resultMessage });
      } catch (error) {
        const output = JSON.stringify({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
        pendingOutputs.push({
          callId: call.id,
          ...(call.namespace ? { namespace: call.namespace } : {}),
          output,
        });
        const resultMessage: AgentToolResultMessage = {
          role: 'tool-result',
          callId: call.id,
          ...(call.namespace ? { namespace: call.namespace } : {}),
          output,
        };
        generatedMessages.push(resultMessage);
        await options.onEvent?.({ type: 'tool-error', call, error, message: resultMessage });
      }
    }

    continuationMessages = await takeSteers();
  }
}
