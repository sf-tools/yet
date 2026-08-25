import type { AgentStore } from '@/store';
import type { SlashCommandSuggestion } from './types';

export function acceptSlashCommandSuggestion(
  store: AgentStore,
  suggestion: SlashCommandSuggestion,
) {
  const state = store.getState();
  const beforeCursor = state.inputChars.slice(0, state.cursor).join('');
  const afterCursor = state.inputChars.slice(state.cursor).join('');
  const match = beforeCursor.match(/^\/[^\s]*$/) || beforeCursor.match(/^\/[^\s]+\s+[^\s]*$/);
  if (!match) return false;

  const replacement = suggestion.replacement;
  const next = `${beforeCursor.slice(0, beforeCursor.length - match[0].length)}${replacement}${afterCursor}`;
  const nextCursor = beforeCursor.length - match[0].length + replacement.length;

  store.replaceInput(next, nextCursor);
  return true;
}
