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
};

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

function mergeEntries(...groups: MentionEntry[][]) {
  const merged: MentionEntry[] = [];
  const seen = new Set<string>();

  for (const group of groups) {
    for (const entry of group) {
      if (seen.has(entry.label)) continue;
      seen.add(entry.label);
      merged.push(entry);
    }
  }

  return merged.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'file' ? -1 : 1;
    return a.label.localeCompare(b.label);
  });
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
  if (query === null) return [];

  startMentionIndex(cwd);
  const stats = getMentionIndexStats(cwd);
  const { directory, fragment } = splitMentionQuery(query, cwd);

  try {
    const localEntries =
      directory || !query || stats.state !== MentionIndexState.Ready
        ? fallbackSearchMentionEntries(
            listDirectoryEntries(cwd, directory),
            directory ? fragment : query,
            24,
          )
        : [];
    const workspaceEntries = query ? queryMentionIndex(query, 24, cwd) : [];

    return mergeEntries(localEntries, workspaceEntries)
      .slice(0, 6)
      .map<MentionSuggestion>(entry => ({ kind: 'mention', label: entry.label }));
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
