import chalk from 'chalk';

import {
  formatThinkingMode,
  getSupportedThinkingModes,
  getThinkingModeDescription,
  isReasoningCapableOpenAIModel,
  type ThinkingMode,
} from '@/config';
import type { SlashCommand } from '../types';

const ARGUMENT_SUGGESTIONS: ThinkingMode[] = [
  'auto',
  'none',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

function isThinkingMode(value: string): value is ThinkingMode {
  return ARGUMENT_SUGGESTIONS.includes(value as ThinkingMode);
}

function thinkingModeStyle(mode: ThinkingMode) {
  switch (mode) {
    case 'auto':
      return chalk.cyanBright;
    case 'none':
      return chalk.gray;
    case 'low':
      return chalk.greenBright;
    case 'medium':
      return chalk.yellowBright;
    case 'high':
      return chalk.redBright;
    case 'xhigh':
      return chalk.magentaBright;
    case 'max':
      return chalk.redBright.bold;
  }
}

const EFFORT_ARGUMENT_SUGGESTIONS = ARGUMENT_SUGGESTIONS.map(mode => ({
  value: mode,
  label: mode,
  detail: getThinkingModeDescription(mode),
  labelStyle: thinkingModeStyle(mode),
}));

export const effortSlashCommand: SlashCommand = {
  name: 'effort',
  description: 'Set model reasoning effort. Shift+Tab also cycles it.',
  suggestedInput: 'high',
  argumentSuggestions: EFFORT_ARGUMENT_SUGGESTIONS,
  showArgumentSuggestionsOnExactInvocation: true,
  execute({ store, openCommandArgumentPicker, setThinkingMode, showFooterNotice }, args) {
    if (args.argv.length > 1) throw new Error(`/${args.invocation} accepts at most one argument`);

    const model = store.getState().currentModel;
    if (!isReasoningCapableOpenAIModel(model)) {
      throw new Error(`/${args.invocation} is not supported for ${model}`);
    }

    const requested = args.argv[0]?.toLowerCase();
    if (!requested) {
      openCommandArgumentPicker('effort');
      return;
    }

    if (!isThinkingMode(requested))
      throw new Error(`invalid /${args.invocation} level: ${requested}`);
    if (!getSupportedThinkingModes(model).includes(requested))
      throw new Error(`/${args.invocation} level ${requested} is not supported for ${model}`);

    setThinkingMode(requested);
    showFooterNotice(`Effort set to ${formatThinkingMode(requested)}`);
  },
};
