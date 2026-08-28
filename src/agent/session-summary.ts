import type { AgentUsage } from './messages';

function formatInteger(value: number) {
  const rounded = Math.max(0, Math.floor(value));
  return String(rounded).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function sessionUsageIsZero(usage: AgentUsage) {
  return (
    usage.inputTokens <= 0 &&
    usage.outputTokens <= 0 &&
    usage.reasoningTokens <= 0 &&
    usage.cachedInputTokens <= 0
  );
}

export function formatSessionUsage(usage: AgentUsage) {
  const cachedInputTokens = Math.max(0, Math.floor(usage.cachedInputTokens));
  const inputTokens = Math.max(0, Math.floor(usage.inputTokens) - cachedInputTokens);
  const outputTokens = Math.max(0, Math.floor(usage.outputTokens));
  const reasoningTokens = Math.max(0, Math.floor(usage.reasoningTokens));
  const totalTokens = inputTokens + outputTokens;

  return [
    `Token usage: total=${formatInteger(totalTokens)}`,
    `input=${formatInteger(inputTokens)}${cachedInputTokens > 0 ? ` (+ ${formatInteger(cachedInputTokens)} cached)` : ''}`,
    `output=${formatInteger(outputTokens)}${reasoningTokens > 0 ? ` (reasoning ${formatInteger(reasoningTokens)})` : ''}`,
  ].join(' ');
}
