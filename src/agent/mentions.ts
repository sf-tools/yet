import { readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AgentStore } from '@/store';

import {
  fallbackSearchMentionEntries,
  getMentionIndexStats,
  type MentionIndexEntry,
  MentionIndexState,
  queryMentionIndex,
  startMentionIndex,
} from './mention-index';

export type MentionSuggestion = {
  kind: 'mention';
  label: string;
  name: string;
  parentPath: string;
  resourceKind: 'File' | 'Dir';
};

function parentPathFor(entry: MentionEntry) {
  const normalized = entry.label.replace(/\/$/, '');
  const slashIndex = normalized.lastIndexOf('/');
  return slashIndex === -1 ? './' : normalized.slice(0, slashIndex + 1);
}

function currentMentionMatch(inputChars: string[], cursor: number) {
  const beforeCursor = inputChars.slice(0, cursor).join('');
  return beforeCursor.match(/(?:^|\s)@([^\s]*)$/);
}

function splitMentionQuery(query: string, cwd: string) {
  if (query && !query.endsWith('/')) {
    try {
      if (statSync(resolve(cwd, query)).isDirectory())
        return { directory: `${query}/`, fragment: '' };
    } catch {}
  }

  const slashIndex = query.lastIndexOf('/');
  if (slashIndex === -1) return { directory: '', fragment: query };

  return {
    directory: query.slice(0, slashIndex + 1),
    fragment: query.slice(slashIndex + 1),
  };
}

type MentionEntry = MentionIndexEntry;

function listDirectoryEntries(cwd: string, directory: string) {
  return readdirSync(resolve(cwd, directory || '.'), { withFileTypes: true })
    .filter(entry => !entry.name.startsWith('.'))
    .map<MentionEntry>(entry => ({
      label: `${directory}${entry.name}${entry.isDirectory() ? '/' : ''}`,
      name: entry.name,
      kind: entry.isDirectory() ? 'folder' : 'file',
      searchPath: `${directory}${entry.name}`,
    }));
}

export function currentMentionQuery(inputChars: string[], cursor: number) {
  return currentMentionMatch(inputChars, cursor)?.[1] ?? null;
}

export function listMentionSuggestions(
  inputChars: string[],
  cursor: number,
  cwd = process.cwd(),
): MentionSuggestion[] {
  const query = currentMentionQuery(inputChars, cursor);
  if (!query) return [];

  startMentionIndex(cwd);
  const stats = getMentionIndexStats(cwd);
  const { directory, fragment } = splitMentionQuery(query, cwd);

  try {
    const entries =
      stats.state === MentionIndexState.Ready
        ? queryMentionIndex(query, 24, cwd)
        : fallbackSearchMentionEntries(
            listDirectoryEntries(cwd, directory),
            directory ? fragment : query,
            24,
          );

    return entries
      .slice(0, 6)
      .map<MentionSuggestion>(entry => ({
        kind: 'mention',
        label: entry.label,
        name: entry.name,
        parentPath: parentPathFor(entry),
        resourceKind: entry.kind === 'folder' ? 'Dir' : 'File',
      }));
  } catch {
    return [];
  }
}

export function acceptMentionSuggestion(store: AgentStore, suggestion: MentionSuggestion) {
  const state = store.getState();
  const match = currentMentionMatch(state.inputChars, state.cursor);
  if (!match) return false;

  const beforeCursor = state.inputChars.slice(0, state.cursor).join('');
  const afterCursor = state.inputChars.slice(state.cursor).join('');

  const fullMatch = match[0];
  const leadingWhitespace = fullMatch.startsWith(' ') ? ' ' : '';
  const replacement = `${leadingWhitespace}@${suggestion.label}${suggestion.label.endsWith('/') ? '' : ' '}`;
  const next = `${beforeCursor.slice(0, beforeCursor.length - fullMatch.length)}${replacement}${afterCursor}`;

  store.replaceInput(next, beforeCursor.length - fullMatch.length + replacement.length);
  return true;
}
