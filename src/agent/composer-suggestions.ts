import chalk from 'chalk';

import { getOpenAIModelDisplayName, isReasoningCapableOpenAIModel } from '@/config';
import {
  acceptMentionSuggestion,
  currentMentionQuery,
  listMentionSuggestions,
  type MentionSuggestion,
} from './mentions';
import {
  acceptSlashCommandSuggestion,
  currentSlashCommandQuery,
  type SlashCommandRegistry,
  type SlashCommandSuggestion,
} from './slash-commands';
import type { AgentStore } from '@/store';

export type ComposerSuggestion = MentionSuggestion | SlashCommandSuggestion;

function markSelectedSuggestions(
  suggestions: SlashCommandSuggestion[],
  options: { currentModel: string; thinkingMode: string },
  inputChars: string[],
  cursor: number,
) {
  const reasoningSupported = isReasoningCapableOpenAIModel(options.currentModel);
  const beforeCursor = inputChars.slice(0, cursor).join('').trim();

  if (!reasoningSupported && beforeCursor === '/effort') {
    return [
      {
        kind: 'slash-command' as const,
        label: '/effort',
        detail: `Not available for ${getOpenAIModelDisplayName(options.currentModel)}`,
        invocation: 'effort',
        replacement: '/effort',
        commandName: 'effort',
        isAlias: false,
        disabled: true,
        labelStyle: chalk.dim,
        detailStyle: chalk.dim,
      },
    ];
  }

  const marked = suggestions.map(suggestion => {
    if (
      suggestion.commandName === 'model' &&
      suggestion.replacement === `/model ${options.currentModel}`
    ) {
      return {
        ...suggestion,
        suffix: `${suggestion.suffix ?? ''} ✓`,
        suffixStyle: chalk.green,
      };
    }

    if (
      suggestion.commandName === 'effort' &&
      suggestion.replacement === `/effort ${options.thinkingMode}`
    ) {
      return {
        ...suggestion,
        suffix: `${suggestion.suffix ?? ''} ✓`,
        suffixStyle: chalk.green,
      };
    }

    if (!reasoningSupported && suggestion.commandName === 'effort') {
      return {
        ...suggestion,
        disabled: true,
        detail: `Not available for ${getOpenAIModelDisplayName(options.currentModel)}`,
        labelStyle: chalk.dim,
        detailStyle: chalk.dim,
        suffixStyle: undefined,
      };
    }

    return suggestion;
  });

  const currentModelIndex = marked.findIndex(
    suggestion =>
      suggestion.commandName === 'model' &&
      suggestion.replacement === `/model ${options.currentModel}`,
  );

  if (currentModelIndex > 0) {
    const [currentModelSuggestion] = marked.splice(currentModelIndex, 1);
    marked.unshift(currentModelSuggestion);
  }

  return marked;
}

export function listComposerSuggestions(
  inputChars: string[],
  cursor: number,
  commands: SlashCommandRegistry,
  options: { currentModel: string; thinkingMode: string },
): ComposerSuggestion[] {
  const slashQuery = currentSlashCommandQuery(inputChars, cursor);
  if (slashQuery !== null)
    return markSelectedSuggestions(
      commands.listSuggestions(slashQuery),
      options,
      inputChars,
      cursor,
    );

  if (currentMentionQuery(inputChars, cursor) !== null)
    return listMentionSuggestions(inputChars, cursor);
  return [];
}

export function acceptComposerSuggestion(store: AgentStore, suggestions: ComposerSuggestion[]) {
  const suggestion = suggestions[store.getState().selectedSuggestion];
  if (!suggestion) return false;

  if (suggestion.kind === 'slash-command') {
    if (suggestion.disabled) return false;
    return acceptSlashCommandSuggestion(store, suggestion);
  }
  return acceptMentionSuggestion(store, suggestion);
}
