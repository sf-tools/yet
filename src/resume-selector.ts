import { stdin, stdout } from 'node:process';
import chalk from 'chalk';

import type { YetSessionListEntry } from '@/agent/session-storage';
import parseKeypress from '@/keypress';

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

function ellipsize(text: string, width: number) {
  if (width <= 0) return '';
  if (text.length <= width) return text;
  if (width === 1) return '…';
  return `${text.slice(0, width - 1)}…`;
}

function normalizeText(text: string | undefined, fallback: string) {
  return text?.replace(/\s+/g, ' ').trim() || fallback;
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
  if (!right) return ellipsize(left, width);
  if (right.length >= width) return ellipsize(right, width);

  const leftWidth = Math.max(1, width - right.length - 1);
  const clippedLeft = ellipsize(left, leftWidth);
  const gap = Math.max(1, width - clippedLeft.length - right.length);
  return `${clippedLeft}${' '.repeat(gap)}${right}`;
}

function renderSelector(
  sessions: YetSessionListEntry[],
  selectedIndex: number,
  workspacePath: string,
) {
  const terminalWidth = Math.max(40, stdout.columns || 80);
  const height = Math.max(12, stdout.rows || 24);
  const contentWidth = Math.max(36, Math.min(72, terminalWidth - 4));
  const leftPad = '  ';
  const visibleCount = Math.max(1, Math.floor((height - 6) / 3));
  const { start, end } = visibleWindow(sessions.length, selectedIndex, visibleCount);

  const lines: string[] = [
    chalk.bold(ellipsize('Resume thread', contentWidth)),
    chalk.dim(
      ellipsize(
        `${workspacePath} · ${sessions.length} saved ${sessions.length === 1 ? 'thread' : 'threads'}`,
        contentWidth,
      ),
    ),
    '',
  ];

  for (let index = start; index < end; index += 1) {
    const session = sessions[index];
    const selected = index === selectedIndex;
    const prefix = selected ? chalk.cyan('›') : chalk.dim(' ');
    const title = normalizeText(session.title, 'Untitled thread');
    const meta = `${formatRelativeAge(session.savedAt)} · ${session.sessionId.slice(0, 8)}`;
    const preview = ellipsize(
      normalizeText(session.preview, 'No messages yet'),
      Math.max(10, Math.floor((contentWidth - 4) / 2)),
    );
    const titleLine = joinColumns(title, meta, Math.max(10, contentWidth - 4));

    lines.push(`${prefix} ${selected ? chalk.white(titleLine) : chalk.gray(titleLine)}`);
    lines.push(`  ${chalk.dim(preview)}`);
    lines.push('');
  }

  lines.push(chalk.dim(ellipsize('↑/↓ move · enter resume · esc cancel', contentWidth)));
  return `${lines.map(line => `${leftPad}${line}`).join('\n')}\n`;
}

export async function selectYetResumeSession(
  sessions: YetSessionListEntry[],
  options: { workspacePath: string },
): Promise<YetSessionListEntry | null> {
  if (!stdin.isTTY || !stdout.isTTY)
    throw new Error('resume selection requires an interactive terminal');
  if (sessions.length === 0) return null;

  let selectedIndex = 0;

  return await new Promise<YetSessionListEntry | null>(resolve => {
    const cleanup = () => {
      stdout.off('resize', render);
      stdin.off('data', onData);
      if (stdin.isTTY) stdin.setRawMode?.(false);
      stdout.write('\u001b[?25h\u001b[?1049l');
    };

    const finish = (result: YetSessionListEntry | null) => {
      cleanup();
      resolve(result);
    };

    const render = () => {
      stdout.write('\u001b[2J\u001b[H');
      stdout.write(renderSelector(sessions, selectedIndex, options.workspacePath));
    };

    const move = (delta: number) => {
      selectedIndex = (selectedIndex + delta + sessions.length) % sessions.length;
      render();
    };

    const onData = (chunk: Buffer) => {
      const key = parseKeypress(chunk);

      if (key.name === 'up' || (!key.ctrl && !key.meta && key.name === 'k')) return move(-1);
      if (key.name === 'down' || (!key.ctrl && !key.meta && key.name === 'j')) return move(1);
      if (key.name === 'pageup') return move(-Math.max(1, Math.floor((stdout.rows || 24) / 3)));
      if (key.name === 'pagedown') return move(Math.max(1, Math.floor((stdout.rows || 24) / 3)));
      if (key.name === 'home') {
        selectedIndex = 0;
        render();
        return;
      }
      if (key.name === 'end') {
        selectedIndex = sessions.length - 1;
        render();
        return;
      }
      if (key.name === 'return' || key.name === 'enter') return finish(sessions[selectedIndex]);
      if (key.name === 'escape' || (key.ctrl && key.name === 'c')) return finish(null);
      if (!key.ctrl && !key.meta && key.name === 'number') {
        const index = Number.parseInt(key.sequence, 10) - 1;
        if (Number.isInteger(index) && index >= 0 && index < sessions.length) {
          selectedIndex = index;
          render();
        }
      }
    };

    stdout.write('\u001b[?1049h\u001b[?25l');
    if (stdin.isTTY) stdin.setRawMode?.(true);
    stdin.resume();
    stdin.on('data', onData);
    stdout.on('resize', render);
    render();
  });
}
