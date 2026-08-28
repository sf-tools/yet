import chalk from 'chalk';

import { highlightedCodeBlock } from '@/render/markdown';
import { indent, LEFT_MARGIN, wrapTextBlock } from '@/render/layout';
import { blankLine, line, span } from '@/render/primitives';
import { plain, truncateToWidth, widthOf } from '@/text';
import type { ToolHistoryEntry } from '@/types';
import type { Block, RenderContext } from '@/render/types';
import { asRecord, stringProp } from './shared';

type CommandResult = {
  output: string;
  exitCode?: number;
  sessionId?: number;
  wallTimeSeconds?: number;
  error?: string;
};

type ParsedCommand =
  | { kind: 'read'; name: string; path?: string }
  | { kind: 'list'; path?: string }
  | { kind: 'search'; query: string; path?: string };

function shellWords(command: string) {
  const words: string[] = [];
  const pattern = /"((?:\\.|[^"\\])*)"|'([^']*)'|([^\s]+)/g;
  for (const match of command.matchAll(pattern)) words.push(match[1] ?? match[2] ?? match[3]);
  return words;
}

function nonOption(words: string[], start = 1) {
  return words.slice(start).filter(word => !word.startsWith('-'));
}

function parseExplorationCommand(command: string): ParsedCommand | null {
  if (/[;&|]\s*(?!$)/.test(command) || command.includes('\n')) return null;
  const words = shellWords(command.trim());
  if (words.length === 0) return null;
  const executable = words[0].split('/').pop() || words[0];

  if (['cat', 'bat', 'less'].includes(executable)) {
    const paths = nonOption(words);
    if (paths.length === 0) return null;
    return { kind: 'read', name: paths.join(', '), path: paths[0] };
  }
  if (['head', 'tail'].includes(executable)) {
    const paths = nonOption(words).filter(word => !/^\d+$/.test(word));
    if (paths.length === 0) return null;
    return { kind: 'read', name: paths.join(', '), path: paths[0] };
  }
  if (executable === 'sed') {
    const paths = nonOption(words).filter(word => !/^\d*(?:,\d*)?[pqd]$/.test(word));
    const path = paths.at(-1);
    return path ? { kind: 'read', name: path, path } : null;
  }
  if (executable === 'git' && words[1] === 'show') {
    const target = nonOption(words, 2).at(-1);
    return target ? { kind: 'read', name: target, path: target } : null;
  }
  if (['ls', 'tree'].includes(executable)) {
    const path = nonOption(words).at(-1);
    return { kind: 'list', ...(path ? { path } : {}) };
  }
  if (executable === 'find' || executable === 'fd' || (executable === 'rg' && words.includes('--files'))) {
    const path = executable === 'find' ? nonOption(words).at(0) : nonOption(words).at(-1);
    return { kind: 'list', ...(path && path !== '--files' ? { path } : {}) };
  }
  if (['rg', 'grep', 'ag'].includes(executable) || (executable === 'git' && words[1] === 'grep')) {
    const offset = executable === 'git' ? 2 : 1;
    const args = nonOption(words, offset);
    const query = args[0];
    if (!query) return null;
    const path = args[1];
    return { kind: 'search', query, ...(path ? { path } : {}) };
  }
  return null;
}

export function isCommandToolEntry(entry: ToolHistoryEntry) {
  return ['exec_command', 'write_stdin'].includes(entry.toolName);
}

function commandText(entry: ToolHistoryEntry) {
  return (
    stringProp(entry.input, 'cmd') ||
    entry.title ||
    'command'
  );
}

function interactionCommand(entry: ToolHistoryEntry) {
  return entry.title?.trim() || '';
}

function parseResult(entry: ToolHistoryEntry): CommandResult {
  const raw = typeof entry.output === 'string' ? entry.output : '';
  if (entry.errorText) return { output: '', error: entry.errorText };

  try {
    const parsed = JSON.parse(raw) as unknown;
    const object = asRecord(parsed);
    if (object) {
      return {
        output: typeof object.output === 'string' ? plain(object.output).trimEnd() : '',
        ...(typeof object.exit_code === 'number' ? { exitCode: object.exit_code } : {}),
        ...(typeof object.session_id === 'number' ? { sessionId: object.session_id } : {}),
        ...(typeof object.wall_time_seconds === 'number'
          ? { wallTimeSeconds: object.wall_time_seconds }
          : {}),
        ...(typeof object.error === 'string' ? { error: object.error } : {}),
      };
    }
  } catch {}

  return { output: plain(raw).trimEnd() };
}

function shellCommandLine(command: string, ctx: RenderContext, prefix: '$ ' | ''): Block {
  const highlighted = highlightedCodeBlock(command, 'bash', ctx);
  if (highlighted.length === 0) return [line(span(prefix, chalk.magentaBright))];
  const [first, ...rest] = highlighted;
  return [
    line(span(prefix, chalk.magentaBright), ...first.segments),
    ...rest.map(part => line(span(' '.repeat(widthOf(prefix))), ...part.segments)),
  ];
}

function statusLine(result: CommandResult, ctx: RenderContext) {
  const failed = Boolean(result.error) || (result.exitCode !== undefined && result.exitCode !== 0);
  const mark = failed ? '✗' : '✓';
  const style = failed ? chalk.redBright.bold : chalk.greenBright.bold;
  const elapsed = result.wallTimeSeconds === undefined
    ? ''
    : ` • ${result.wallTimeSeconds < 1 ? `${Math.max(1, Math.round(result.wallTimeSeconds * 1_000))}ms` : `${result.wallTimeSeconds.toFixed(1)}s`}`;
  return line(
    span(mark, style),
    ...(failed && result.exitCode !== undefined ? [span(` (${result.exitCode})`)] : []),
    ...(elapsed ? [span(elapsed, ctx.theme.dimmed)] : []),
  );
}

function commandOutputLines(text: string, maxLines = 5) {
  const lines = text ? text.split('\n') : ['(no output)'];
  if (lines.length <= maxLines) return lines;
  const hidden = lines.length - (maxLines - 1);
  const headCount = Math.ceil((maxLines - 1) / 2);
  const tailCount = Math.floor((maxLines - 1) / 2);
  return [
    ...lines.slice(0, headCount),
    `… +${hidden} lines (ctrl + t to view transcript)`,
    ...lines.slice(lines.length - tailCount),
  ];
}

function compactCommand(
  label: 'Running' | 'Ran',
  command: string,
  output: string,
  ctx: RenderContext,
  failed = false,
): Block {
  const commandLines = command.split('\n').map(text => text.trim()).filter(Boolean);
  const visibleCommandLines = commandLines.length <= 4
    ? commandLines
    : [...commandLines.slice(0, 3), `… +${commandLines.length - 3} lines`];
  const available = Math.max(1, ctx.width - 5 - widthOf(label));
  const commandPreview = truncateToWidth(visibleCommandLines[0] ?? command.trim(), available);
  const block: Block = [
    line(
      span('• ', failed ? chalk.redBright : label === 'Ran' ? chalk.greenBright : ctx.theme.dimmed),
      span(label, chalk.bold),
      span(' '),
      span(commandPreview, failed ? chalk.redBright : undefined),
    ),
  ];
  visibleCommandLines.slice(1).forEach(commandLine => {
    block.push(
      line(
        span('  │ ', ctx.theme.dimmed),
        span(truncateToWidth(commandLine, Math.max(1, ctx.width - 4))),
      ),
    );
  });
  const outputLines = commandOutputLines(output);
  let firstOutputLine = true;
  outputLines.forEach(text => {
    const wrapped = wrapTextBlock(
      text,
      Math.max(1, ctx.width - 4),
      failed ? chalk.redBright.dim : ctx.theme.dimmed,
    );
    for (const outputLine of wrapped) {
      block.push(
        line(
          span(firstOutputLine ? '  └ ' : '    ', ctx.theme.dimmed),
          ...outputLine.segments,
        ),
      );
      firstOutputLine = false;
    }
  });
  return block;
}

function renderExploration(
  commands: Array<{ parsed: ParsedCommand; running: boolean }>,
  ctx: RenderContext,
): Block {
  const running = commands.some(command => command.running);
  const block: Block = [
    line(
      span('• ', ctx.theme.dimmed),
      span(running ? 'Exploring' : 'Explored', chalk.bold),
    ),
  ];
  commands.forEach(({ parsed }, index) => {
    const prefix = index === 0 ? '  └ ' : '    ';
    if (parsed.kind === 'read') {
      block.push(line(span(prefix, ctx.theme.dimmed), span('Read ', chalk.cyanBright), span(parsed.name)));
    } else if (parsed.kind === 'list') {
      block.push(
        line(
          span(prefix, ctx.theme.dimmed),
          span('List', chalk.cyanBright),
          ...(parsed.path ? [span(' '), span(parsed.path)] : []),
        ),
      );
    } else {
      block.push(
        line(
          span(prefix, ctx.theme.dimmed),
          span('Search ', chalk.cyanBright),
          span(parsed.query),
          ...(parsed.path ? [span(' in '), span(parsed.path)] : []),
        ),
      );
    }
  });
  return block;
}

function renderInteraction(entry: ToolHistoryEntry, ctx: RenderContext): Block {
  const stdin = stringProp(entry.input, 'chars') ?? '';
  const command = interactionCommand(entry);
  const waitedOnly = stdin.length === 0;
  const header = waitedOnly
    ? line(
        span('• '),
        span('Waited for background terminal', chalk.bold),
        ...(command ? [span(' · ', ctx.theme.dimmed), span(command, ctx.theme.dimmed)] : []),
      )
    : line(
        span('↳ ', ctx.theme.dimmed),
        span('Interacted with background terminal', chalk.bold),
        ...(command ? [span(' · ', ctx.theme.dimmed), span(command, ctx.theme.dimmed)] : []),
      );
  if (waitedOnly) return [header];

  const input = stdin
    .split('\n')
    .flatMap(text => wrapTextBlock(text, Math.max(1, ctx.width - 4)));
  return [
    header,
    ...input.map((entry, index) =>
      line(span(index === 0 ? '  └ ' : '    ', ctx.theme.dimmed), ...entry.segments),
    ),
  ];
}

export function commandActivityIsRunning(entries: ToolHistoryEntry[]) {
  return entries
    .filter(entry => entry.toolName === 'exec_command')
    .some(entry => {
      const result = parseResult(entry);
      return entry.status === 'running' ||
        (result.sessionId !== undefined && result.exitCode === undefined && !result.error);
    });
}

export function renderCommandActivity(
  entries: ToolHistoryEntry[],
  ctx: RenderContext,
  options: { transcript?: boolean } = {},
): Block {
  const execEntries = entries.filter(entry => entry.toolName !== 'write_stdin');
  const writes = entries.filter(entry => entry.toolName === 'write_stdin');

  const commands = execEntries.map(entry => {
    const initial = parseResult(entry);
    const failed =
      entry.status === 'failed' ||
      Boolean(initial.error) ||
      (initial.exitCode !== undefined && initial.exitCode !== 0);
    const running =
      entry.status === 'running' ||
      (initial.sessionId !== undefined && initial.exitCode === undefined && !initial.error);
    return {
      entry,
      command: commandText(entry),
      result: initial,
      failed,
      running,
      parsed: parseExplorationCommand(commandText(entry)),
    };
  });

  if (options.transcript) {
    const block: Block = [];
    commands.forEach((command, index) => {
      if (index > 0) block.push(blankLine());
      block.push(...shellCommandLine(command.command, ctx, '$ '));
      if (command.result.output) {
        block.push(...command.result.output.split('\n').map(text => line(span(text, command.failed ? chalk.redBright : undefined))));
      }
      if (!command.running) block.push(statusLine(command.result, ctx));
    });
    writes.forEach((entry, index) => {
      if (commands.length > 0 || index > 0) block.push(blankLine());
      block.push(...renderInteraction(entry, ctx));
    });
    return indent(block, LEFT_MARGIN);
  }

  if (commands.length === 0 && writes.length === 0) return [];
  const completed = commands.filter(command => !command.running && !command.failed);
  const running = commands.filter(command => command.running);
  const failed = commands.filter(command => command.failed);
  const block: Block = [];

  const exploration = commands.length > 0 && writes.length === 0 && commands.every(command =>
    command.parsed && !command.failed,
  );
  if (exploration) {
    return indent(
      renderExploration(
        commands.map(command => ({ parsed: command.parsed!, running: command.running })),
        ctx,
      ),
      LEFT_MARGIN,
    );
  }

  if (completed.length === 1 && commands.length === 1 && writes.length === 0) {
    const command = completed[0];
    block.push(...compactCommand('Ran', command.command, command.result.output, ctx));
  } else if (completed.length > 0) {
    block.push(
      line(
        span('•', chalk.green.bold),
        span(' '),
        span(`Ran ${completed.length} command${completed.length === 1 ? '' : 's'}`, chalk.bold),
        span(' · ctrl + t to view transcript', ctx.theme.dimmed),
      ),
    );
  }

  for (const command of running) {
    block.push(...compactCommand('Running', command.command, command.result.output, ctx));
  }
  for (const command of failed) {
    block.push(
      ...compactCommand(
        'Ran',
        command.command,
        command.result.error || command.result.output,
        ctx,
        true,
      ),
    );
  }
  writes.forEach(entry => {
    if (block.length > 0) block.push(blankLine());
    block.push(...renderInteraction(entry, ctx));
  });
  return indent(block, LEFT_MARGIN);
}
