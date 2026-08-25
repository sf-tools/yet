export const DEFAULT_MODEL = 'gpt-5.6-sol';

export type ThinkingMode = 'auto' | 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type OpenAIModelOption = {
  id: string;
  providerId: string;
  label: string;
  description: string;
  contextWindow: number;
  efforts: ThinkingMode[];
};

const STANDARD_EFFORTS: ThinkingMode[] = ['auto', 'none', 'low', 'medium', 'high', 'xhigh'];
const FRONTIER_EFFORTS: ThinkingMode[] = [...STANDARD_EFFORTS, 'max'];

export const OPENAI_MODEL_OPTIONS: OpenAIModelOption[] = [
  {
    id: 'gpt-5.6-sol',
    providerId: 'gpt-5.6-sol',
    label: 'gpt-5.6-sol',
    description: 'Latest frontier agentic coding model.',
    contextWindow: 1_050_000,
    efforts: FRONTIER_EFFORTS,
  },
  {
    id: 'gpt-5.6-terra',
    providerId: 'gpt-5.6-terra',
    label: 'gpt-5.6-terra',
    description: 'Balanced agentic coding model for everyday work.',
    contextWindow: 1_050_000,
    efforts: FRONTIER_EFFORTS,
  },
  {
    id: 'gpt-5.6-luna',
    providerId: 'gpt-5.6-luna',
    label: 'gpt-5.6-luna',
    description: 'Fast and affordable agentic coding model.',
    contextWindow: 1_050_000,
    efforts: FRONTIER_EFFORTS,
  },
  {
    id: 'gpt-daybreak-blue-latest',
    providerId: 'daybreak-blue-latest',
    label: 'gpt-daybreak-blue-latest',
    description: 'Latest frontier agentic coding model for broad defensive cybersecurity work.',
    contextWindow: 1_050_000,
    efforts: FRONTIER_EFFORTS,
  },
  {
    id: 'gpt-5.5',
    providerId: 'gpt-5.5',
    label: 'gpt-5.5',
    description: 'Frontier model for complex coding, research, and real-world work.',
    contextWindow: 1_050_000,
    efforts: STANDARD_EFFORTS,
  },
  {
    id: 'gpt-5.4',
    providerId: 'gpt-5.4',
    label: 'gpt-5.4',
    description: 'Strong model for everyday coding.',
    contextWindow: 1_050_000,
    efforts: STANDARD_EFFORTS,
  },
  {
    id: 'gpt-5.4-mini',
    providerId: 'gpt-5.4-mini',
    label: 'gpt-5.4-mini',
    description: 'Small, fast, and cost-efficient model for simpler coding tasks.',
    contextWindow: 400_000,
    efforts: STANDARD_EFFORTS,
  },
  {
    id: 'gpt-5.3-codex-spark',
    providerId: 'gpt-5.3-codex-spark',
    label: 'gpt-5.3-codex-spark',
    description: 'Ultra-fast coding model.',
    contextWindow: 128_000,
    efforts: STANDARD_EFFORTS,
  },
];

const MODEL_OPTION_MAP = new Map(OPENAI_MODEL_OPTIONS.map(option => [option.id, option]));

export function normalizeOpenAIModelId(model: string) {
  return model.trim().toLowerCase();
}

export function getKnownOpenAIModel(model: string) {
  return MODEL_OPTION_MAP.get(normalizeOpenAIModelId(model));
}

export function isSupportedOpenAIModel(model: string) {
  return getKnownOpenAIModel(model) !== undefined;
}

export function getOpenAIProviderModelId(model: string) {
  const option = getKnownOpenAIModel(model);
  if (!option) throw new Error(`unsupported model: ${model}`);
  return option.providerId;
}

export function getOpenAIModelDisplayName(model: string) {
  return getKnownOpenAIModel(model)?.label ?? model;
}

export function getOpenAIModelDescription(model: string) {
  return getKnownOpenAIModel(model)?.description ?? null;
}

export function getOpenAIContextWindow(model: string) {
  return getKnownOpenAIModel(model)?.contextWindow ?? null;
}

export function isReasoningCapableOpenAIModel(model: string) {
  return isSupportedOpenAIModel(model);
}

export function getSupportedThinkingModes(model: string): ThinkingMode[] {
  return getKnownOpenAIModel(model)?.efforts ?? ['auto'];
}

export function isThinkingMode(value: unknown): value is ThinkingMode {
  return (
    value === 'auto' ||
    value === 'none' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh' ||
    value === 'max'
  );
}

export function cycleThinkingMode(current: ThinkingMode, model: string) {
  const supportedModes = getSupportedThinkingModes(model);
  const index = supportedModes.indexOf(current);
  return supportedModes[(index + 1 + supportedModes.length) % supportedModes.length] ?? 'auto';
}

export function formatThinkingMode(thinkingMode: ThinkingMode) {
  return thinkingMode;
}

export function getThinkingModeDescription(thinkingMode: ThinkingMode) {
  switch (thinkingMode) {
    case 'auto':
      return 'Let the model choose the effort level';
    case 'none':
      return 'Disable deliberate reasoning';
    case 'low':
      return 'Fast reasoning with low latency';
    case 'medium':
      return 'Balanced speed and depth';
    case 'high':
      return 'Deep reasoning for difficult work';
    case 'xhigh':
      return 'Extra-high reasoning for complex work';
    case 'max':
      return 'Maximum supported reasoning effort';
  }
}
