import { addUsage, EMPTY_USAGE, type AgentMessage, type AgentUsage } from './messages';
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
  | { type: 'tool-call'; call: ProviderToolCall }
  | { type: 'tool-result'; call: ProviderToolCall; result: ToolExecutionResult }
  | { type: 'tool-error'; call: ProviderToolCall; error: unknown }
  | { type: 'step-completed'; usage: AgentUsage };

export type RunAgentLoopOptions = {
  model: string;
  thinkingMode: ThinkingMode;
  messages: AgentMessage[];
  tools: ToolRegistry;
  maxSteps?: number;
  signal?: AbortSignal;
  onEvent?: (event: AgentLoopEvent) => void | Promise<void>;
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
  const maxSteps = Math.max(1, Math.min(options.maxSteps ?? 20, 20));
  let previousResponseId: string | undefined;
  let pendingOutputs: ProviderToolOutput[] | undefined;
  let accumulatedText = '';
  let accumulatedReasoning = '';
  let accumulatedUsage = EMPTY_USAGE;
  const generatedMessages: AgentMessage[] = [];

  for (let stepIndex = 0; stepIndex < maxSteps; stepIndex += 1) {
    options.signal?.throwIfAborted();
    const step = await streamOpenAIResponse({
      model: options.model,
      thinkingMode: options.thinkingMode,
      messages: options.messages,
      tools: options.tools.list(),
      previousResponseId,
      toolOutputs: pendingOutputs,
      signal: options.signal,
      onEvent: event => options.onEvent?.(event),
    });

    previousResponseId = step.responseId;
    accumulatedText += step.text;
    accumulatedReasoning += step.reasoning;
    accumulatedUsage = addUsage(accumulatedUsage, step.usage);
    if (step.text.trim()) generatedMessages.push({ role: 'assistant', content: step.text });
    await options.onEvent?.({ type: 'step-completed', usage: step.usage });

    if (step.toolCalls.length === 0) {
      return {
        responseId: step.responseId,
        text: accumulatedText,
        reasoning: accumulatedReasoning,
        usage: accumulatedUsage,
        messages: generatedMessages,
      };
    }

    pendingOutputs = [];
    for (const call of step.toolCalls) {
      generatedMessages.push({
        role: 'tool-call',
        callId: call.id,
        name: call.name,
        input: call.input,
      });
      await options.onEvent?.({ type: 'tool-call', call });
      try {
        const result = await options.tools.execute(call.name, call.input);
        await options.onEvent?.({ type: 'tool-result', call, result });
        const output = JSON.stringify({ ok: true, output: toolOutput(result.output) });
        pendingOutputs.push({
          callId: call.id,
          output,
        });
        generatedMessages.push({ role: 'tool-result', callId: call.id, output });
      } catch (error) {
        await options.onEvent?.({ type: 'tool-error', call, error });
        const output = JSON.stringify({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
        pendingOutputs.push({
          callId: call.id,
          output,
        });
        generatedMessages.push({ role: 'tool-result', callId: call.id, output });
      }
    }
  }

  throw new Error(`agent loop exceeded its ${maxSteps}-step limit`);
}
