import { stdin, stdout } from 'node:process';
import chalk from 'chalk';

import {
  listYetSessions,
  loadYetSession,
  type YetSessionListEntry,
} from '@/agent/session-storage';
import parseKeypress from '@/keypress';
import { createRenderContext, serializeBlock } from '@/render';
import {
  renderTranscriptContent,
  renderTranscriptViewport,
} from '@/render/components/transcript-overlay';
import { createTheme, type ThemePalette } from '@/theme';
import { repeat, truncateToWidth, widthOf } from '@/text';

export type YetResumePickerResult =
  | { action: 'resume'; session: YetSessionListEntry }
  | { action: 'start-new' }
  | { action: 'cancel' };

type PickerStatus = 'active' | 'archived';
type PickerFolder = 'current' | 'all';

type PickerState = {
  activeSessions: YetSessionListEntry[];
  archivedSessions: YetSessionListEntry[];
  workspacePath: string;
  launchContext: 'startup' | 'in-session';
  currentSessionId?: string;
  query: string;
  status: PickerStatus;
  folder: PickerFolder;
  selectedIndex: number;
  transcript: { content: ReturnType<typeof renderTranscriptContent>; scrollOffset: number } | null;
};

function formatRelativeAge(isoTime: string) {
  const timestamp = Date.parse(isoTime);
  if (!Number.isFinite(timestamp)) return 'unknown';

  const ageSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1_000));
  if (ageSeconds < 60) return `${ageSeconds}s ago`;
  if (ageSeconds < 60 * 60) return `${Math.floor(ageSeconds / 60)}m ago`;
  if (ageSeconds < 60 * 60 * 24) return `${Math.floor(ageSeconds / (60 * 60))}h ago`;
  if (ageSeconds < 60 * 60 * 24 * 30) return `${Math.floor(ageSeconds / (60 * 60 * 24))}d ago`;
  if (ageSeconds < 60 * 60 * 24 * 365)
    return `${Math.floor(ageSeconds / (60 * 60 * 24 * 30))}mo ago`;
  return `${Math.floor(ageSeconds / (60 * 60 * 24 * 365))}y ago`;
}

function formatAbsoluteTime(isoTime: string) {
  const timestamp = Date.parse(isoTime);
  if (!Number.isFinite(timestamp)) return 'unknown';
  return new Date(timestamp).toLocaleString();
}

function normalizeText(text: string | undefined, fallback: string) {
  return text?.replace(/\s+/g, ' ').trim() || fallback;
}

function normalizedPath(path: string) {
  return path.replace(/\\/g, '/').replace(/\/$/, '');
}

function sameFolder(left: string, right: string) {
  return normalizedPath(left) === normalizedPath(right);
}

function queryMatches(session: YetSessionListEntry, query: string) {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = [session.title, session.preview, session.sessionId, session.cwd]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
  return terms.every(term => haystack.includes(term));
}

export function filterYetResumeSessions(state: Pick<
  PickerState,
  | 'activeSessions'
  | 'archivedSessions'
  | 'workspacePath'
  | 'currentSessionId'
  | 'query'
  | 'status'
  | 'folder'
>) {
  const source = state.status === 'archived' ? state.archivedSessions : state.activeSessions;
  return source
    .filter(session => session.sessionId !== state.currentSessionId)
    .filter(session => state.folder === 'all' || sameFolder(session.cwd, state.workspacePath))
    .filter(session => queryMatches(session, state.query))
    .slice()
    .sort((left, right) => Date.parse(right.savedAt) - Date.parse(left.savedAt));
}

function visibleWindow(total: number, selected: number, visibleCount: number) {
  if (total <= visibleCount) return { start: 0, end: total };
  const half = Math.floor(visibleCount / 2);
  let start = Math.max(0, selected - half);
  const end = Math.min(total, start + visibleCount);
  start = Math.max(0, end - visibleCount);
  return { start, end };
}

function joinColumns(left: string, right: string, width: number) {
  if (width <= 0) return '';
  if (!right) return truncateToWidth(left, width);
  if (widthOf(right) >= width) return truncateToWidth(right, width);
  const leftWidth = Math.max(1, width - widthOf(right) - 1);
  const clippedLeft = truncateToWidth(left, leftWidth);
  return `${clippedLeft}${repeat(' ', Math.max(1, width - widthOf(clippedLeft) - widthOf(right)))}${right}`;
}

function selectedLine(text: string, width: number, background: string) {
  const clipped = truncateToWidth(text, width);
  return chalk.bgHex(background)(`${clipped}${repeat(' ', Math.max(0, width - widthOf(clipped)))}`);
}

function renderSessionRow(
  session: YetSessionListEntry,
  selected: boolean,
  width: number,
  theme: ThemePalette,
) {
  const title = normalizeText(session.title, 'Untitled session');
  const age = formatRelativeAge(session.savedAt);
  const titleLine = joinColumns(`${selected ? '›' : ' '} ${title}`, age, width);
  const metadata = `  ${session.cwd} · ${normalizeText(session.preview, 'No messages yet')}`;

  if (!selected) {
    return [
      chalk.gray(truncateToWidth(titleLine, width)),
      chalk.dim(truncateToWidth(metadata, width)),
    ];
  }

  const background = theme.composerBg();
  const selectedTitle = joinColumns(`${chalk.cyanBright('›')} ${chalk.white(title)}`, chalk.dim(age), width);
  return [
    selectedLine(selectedTitle, width, background),
    selectedLine(chalk.dim(truncateToWidth(metadata, width)), width, background),
  ];
}

export function renderYetResumeSelector(
  state: PickerState,
  theme: ThemePalette,
  columns = stdout.columns || 100,
  rows = stdout.rows || 30,
) {
  if (state.transcript) {
    const ctx = createRenderContext(theme, true, columns, rows);
    const rendered = renderTranscriptViewport(
      state.transcript.content,
      state.transcript.scrollOffset,
      ctx,
    );
    state.transcript.scrollOffset = Math.min(state.transcript.scrollOffset, rendered.maxScroll);
    return serializeBlock(rendered.block).join('\n');
  }

  const margin = columns >= 4 ? ' ' : '';
  const width = Math.max(1, columns - widthOf(margin) - 2);
  const sessions = filterYetResumeSessions(state);
  state.selectedIndex = Math.max(0, Math.min(state.selectedIndex, Math.max(0, sessions.length - 1)));
  const searchText = state.query || 'Type to search sessions';
  const search = selectedLine(
    `${chalk.cyanBright('›')} ${state.query ? chalk.white(searchText) : chalk.dim(searchText)}`,
    width,
    theme.composerBg(),
  );
  const scope = `${state.folder === 'current' ? 'Current folder' : 'All folders'} · ${state.status === 'active' ? 'Active' : 'Archived'}`;
  const availableRows = Math.max(1, rows - 10);
  const visibleCount = Math.max(1, Math.floor(availableRows / 3));
  const { start, end } = visibleWindow(sessions.length, state.selectedIndex, visibleCount);
  const lines = [chalk.bold('Resume session'), '', search, chalk.dim(scope), ''];

  if (sessions.length === 0) {
    lines.push(chalk.dim(state.query ? 'No matching sessions' : 'No sessions yet'));
  } else {
    for (let index = start; index < end; index += 1) {
      const row = renderSessionRow(sessions[index], index === state.selectedIndex, width, theme);
      lines.push(...row);
      lines.push('');
    }
  }

  while (lines.length < Math.max(5, rows - 3)) lines.push('');

  const count = sessions.length === 0 ? '0 / 0' : `${state.selectedIndex + 1} / ${sessions.length}`;
  const suffix = ` ${count} ─`;
  lines.push(chalk.dim(`${repeat('─', Math.max(0, width - widthOf(suffix)))}${suffix}`));
  lines.push(chalk.dim(` ↑/↓ navigate   enter ${state.status === 'archived' ? 'restore' : 'resume'}   esc ${state.query ? 'clear' : state.launchContext === 'startup' ? 'start new' : 'cancel'}   ctrl+t transcript`));
  lines.push(chalk.dim(' tab folders   shift+tab active/archived'));

  return lines.map(line => `${margin}${truncateToWidth(line, width)}`).join('\n');
}

function moveSelection(state: PickerState, delta: number) {
  const sessions = filterYetResumeSessions(state);
  if (sessions.length === 0) return;
  state.selectedIndex = (state.selectedIndex + delta + sessions.length) % sessions.length;
}

function resetSelection(state: PickerState) {
  state.selectedIndex = 0;
}

async function openTranscript(state: PickerState, theme: ThemePalette) {
  const sessionEntry = filterYetResumeSessions(state)[state.selectedIndex];
  if (!sessionEntry) return;
  const session = await loadYetSession(sessionEntry.sessionId, {
    includeArchived: Boolean(sessionEntry.archivedAt),
  });
  if (!session) return;
  const ctx = createRenderContext(theme, true, stdout.columns || 100, stdout.rows || 30);
  state.transcript = {
    content: renderTranscriptContent(session.state.historyEntries, { reasoning: '', assistant: '' }, ctx),
    scrollOffset: 0,
  };
}

export async function selectYetResumeSession(options: {
  workspacePath: string;
  launchContext?: 'startup' | 'in-session';
  currentSessionId?: string;
  showAll?: boolean;
  activeSessions?: YetSessionListEntry[];
  archivedSessions?: YetSessionListEntry[];
}): Promise<YetResumePickerResult> {
  if (!stdin.isTTY || !stdout.isTTY)
    throw new Error('resume selection requires an interactive terminal');

  const [activeSessions, archivedSessions] = await Promise.all([
    options.activeSessions ?? listYetSessions(),
    options.archivedSessions ?? listYetSessions({ archived: true }),
  ]);
  const theme = createTheme();
  await theme.sync();
  const state: PickerState = {
    activeSessions,
    archivedSessions,
    workspacePath: options.workspacePath,
    launchContext: options.launchContext ?? 'startup',
    ...(options.currentSessionId ? { currentSessionId: options.currentSessionId } : {}),
    query: '',
    status: 'active',
    folder: options.showAll ? 'all' : 'current',
    selectedIndex: 0,
    transcript: null,
  };
  const previousRawMode = stdin.isRaw;

  return await new Promise<YetResumePickerResult>(resolve => {
    let settled = false;
    let inputQueue = Promise.resolve();

    const cleanup = () => {
      stdout.off('resize', render);
      stdin.off('data', onData);
      stdin.setRawMode?.(previousRawMode);
      stdout.write('\u001b[?25h\u001b[?1049l');
    };

    const finish = (result: YetResumePickerResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const render = () => {
      if (settled) return;
      const frame = renderYetResumeSelector(state, theme);
      const clearedLines = frame
        .split('\n')
        .map(value => `\u001b[2K${value}`)
        .join('\n');
      stdout.write(`\u001b[H${clearedLines}\u001b[J`);
    };

    const handleTranscriptKey = (key: ReturnType<typeof parseKeypress>) => {
      if (!state.transcript) return false;
      if (key.name === 'escape' || key.name === 'q' || (key.ctrl && key.name === 't')) {
        state.transcript = null;
        render();
        return true;
      }
      const page = Math.max(1, (stdout.rows || 24) - 8);
      if (key.name === 'up' || key.name === 'k') state.transcript.scrollOffset += 1;
      else if (key.name === 'down' || key.name === 'j') state.transcript.scrollOffset = Math.max(0, state.transcript.scrollOffset - 1);
      else if (key.name === 'pageup') state.transcript.scrollOffset += page;
      else if (key.name === 'pagedown') state.transcript.scrollOffset = Math.max(0, state.transcript.scrollOffset - page);
      else if (key.name === 'home') state.transcript.scrollOffset = Number.MAX_SAFE_INTEGER;
      else if (key.name === 'end') state.transcript.scrollOffset = 0;
      else return true;
      render();
      return true;
    };

    const handleData = async (chunk: Buffer) => {
      if (settled) return;
      const key = parseKeypress(chunk);
      if (key.eventType === 'release') return;
      if (handleTranscriptKey(key)) return;

      if (key.ctrl && key.name === 'c') return finish({ action: 'cancel' });
      if (key.ctrl && key.name === 't') {
        await openTranscript(state, theme);
        render();
        return;
      }
      if (key.name === 'tab') {
        if (key.shift) state.status = state.status === 'active' ? 'archived' : 'active';
        else state.folder = state.folder === 'current' ? 'all' : 'current';
        resetSelection(state);
        render();
        return;
      }
      if (key.name === 'up' || (!key.ctrl && !key.meta && key.name === 'k')) {
        moveSelection(state, -1);
        render();
        return;
      }
      if (key.name === 'down' || (!key.ctrl && !key.meta && key.name === 'j')) {
        moveSelection(state, 1);
        render();
        return;
      }
      if (key.name === 'pageup' || key.name === 'pagedown') {
        moveSelection(state, (key.name === 'pageup' ? -1 : 1) * Math.max(1, Math.floor((stdout.rows || 24) / 4)));
        render();
        return;
      }
      if (key.name === 'home' || key.name === 'end') {
        const sessions = filterYetResumeSessions(state);
        state.selectedIndex = key.name === 'home' ? 0 : Math.max(0, sessions.length - 1);
        render();
        return;
      }
      if (key.name === 'return' || key.name === 'enter') {
        const session = filterYetResumeSessions(state)[state.selectedIndex];
        if (session) finish({ action: 'resume', session });
        return;
      }
      if (key.name === 'escape') {
        if (state.query) {
          state.query = '';
          resetSelection(state);
          render();
          return;
        }
        finish(state.launchContext === 'startup' ? { action: 'start-new' } : { action: 'cancel' });
        return;
      }
      if (key.name === 'backspace') {
        state.query = Array.from(state.query).slice(0, -1).join('');
        resetSelection(state);
        render();
        return;
      }
      if (!key.ctrl && !key.meta && key.isPrintable && key.text) {
        state.query += key.text;
        resetSelection(state);
        render();
      }
    };

    const onData = (chunk: Buffer) => {
      inputQueue = inputQueue.then(() => handleData(chunk)).catch(() => {});
    };

    stdout.write('\u001b[?1049h\u001b[2J\u001b[H\u001b[?25l');
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.on('data', onData);
    stdout.on('resize', render);
    render();
  });
}
