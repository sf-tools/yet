import approx from 'approximate-number';

import {
  OPENAI_MODEL_OPTIONS,
  getOpenAIContextWindow,
  getOpenAIModelDescription,
  getOpenAIModelDisplayName,
  normalizeOpenAIModelId,
} from '@/config';
import type { SlashCommand } from '../types';

function findModel(value: string) {
  const normalized = normalizeOpenAIModelId(value);
  return OPENAI_MODEL_OPTIONS.find(option => option.id === normalized);
}

function formatContextWindow(contextWindow?: number | null) {
  return contextWindow ? `${approx(contextWindow, { capital: false, precision: 2 })} ctx` : null;
}

function truncateDescription(text: string | null, maxLength = 58) {
  if (!text) return null;
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

const MODEL_ARGUMENT_SUGGESTIONS = OPENAI_MODEL_OPTIONS.map(option => ({
  value: option.id,
  label: getOpenAIModelDisplayName(option.id),
  detail: [
    truncateDescription(getOpenAIModelDescription(option.id)),
    formatContextWindow(getOpenAIContextWindow(option.id)),
  ]
    .filter(Boolean)
    .join(' · '),
}));

export const modelSlashCommand: SlashCommand = {
  name: 'model',
  description: 'Switch the active model.',
  argumentSuggestions: MODEL_ARGUMENT_SUGGESTIONS,
  showArgumentSuggestionsOnExactInvocation: true,
  execute({ openCommandArgumentPicker, setCurrentModel, showFooterNotice }, args) {
    if (args.argv.length > 1) throw new Error(`/${args.invocation} accepts at most one argument`);

    const requested = args.argv[0];
    if (!requested) {
      openCommandArgumentPicker('model');
      return;
    }

    const model = findModel(requested);
    if (!model) throw new Error(`unknown /${args.invocation} model: ${requested}`);

    setCurrentModel(model.id);
    showFooterNotice(`Model set to ${getOpenAIModelDisplayName(model.id)}`);
  },
};
