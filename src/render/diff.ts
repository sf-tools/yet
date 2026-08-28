import chalk from 'chalk';
import { homedir } from 'node:os';
import { isAbsolute, relative } from 'node:path';

import { formatWorkspacePath, isPrintableAscii, widthOf } from '@/text';
import {
  codeLanguageForPath,
  exceedsSyntaxHighlightLimits,
  highlightedCodeLines,
} from './markdown';
import { blankLine, line, rawLine, span } from './primitives';
import { serializeSegments } from './serialize';
import type { Block, RenderContext, Segment, Style, StyledLine } from './types';
import type { FileChange } from '@/types';

type DiffLineKind = 'insert' | 'delete' | 'context';

type ParsedDiffLine = {
  kind: DiffLineKind;
  text: string;
  oldLineNumber?: number;
  newLineNumber?: number;
};

type ParsedDiffHunk = {
  lines: ParsedDiffLine[];
};

const DARK_ADD_BACKGROUND = '#213a2b';
const DARK_DELETE_BACKGROUND = '#4a221d';
const LIGHT_ADD_BACKGROUND = '#dafbe1';
const LIGHT_DELETE_BACKGROUND = '#ffebe9';
const LIGHT_ADD_GUTTER_BACKGROUND = '#aceebb';
const LIGHT_DELETE_GUTTER_BACKGROUND = '#ffcecb';
const LIGHT_GUTTER_FOREGROUND = '#1f2328';

function composeStyles(...styles: Array<Style | undefined>): Style | undefined {
  const active = styles.filter(Boolean) as Style[];
  if (active.length === 0) return undefined;
  return value => active.reduce((output, style) => style(output), value);
}

function parseUnifiedDiff(diff: string): ParsedDiffHunk[] {
  const hunks: ParsedDiffHunk[] = [];
  let hunk: ParsedDiffHunk | null = null;
  let oldLineNumber = 0;
  let newLineNumber = 0;

  for (const rawLine of diff.split('\n')) {
    const hunkHeader = rawLine.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkHeader) {
      oldLineNumber = Number.parseInt(hunkHeader[1], 10);
      newLineNumber = Number.parseInt(hunkHeader[2], 10);
      hunk = { lines: [] };
      hunks.push(hunk);
      continue;
    }
    if (!hunk || rawLine === '\\ No newline at end of file') continue;

    if (rawLine.startsWith('+')) {
      hunk.lines.push({
        kind: 'insert',
        text: rawLine.slice(1),
        newLineNumber,
      });
      newLineNumber += 1;
      continue;
    }
    if (rawLine.startsWith('-')) {
      hunk.lines.push({
        kind: 'delete',
        text: rawLine.slice(1),
        oldLineNumber,
      });
      oldLineNumber += 1;
      continue;
    }

    hunk.lines.push({
      kind: 'context',
      text: rawLine.startsWith(' ') ? rawLine.slice(1) : rawLine,
      oldLineNumber,
      newLineNumber,
    });
    oldLineNumber += 1;
    newLineNumber += 1;
  }

  return hunks.filter(candidate => candidate.lines.length > 0);
}

function lineCounts(file: FileChange) {
  return {
    added: file.stats.added + file.stats.modified,
    removed: file.stats.removed + file.stats.modified,
  };
}

function countSummary(added: number, removed: number): Segment[] {
  return [
    span('('),
    span(`+${added}`, chalk.green),
    span(' '),
    span(`-${removed}`, chalk.red),
    span(')'),
  ];
}

function changeVerb(file: FileChange) {
  if (file.changeKind === 'created') return 'Added';
  if (file.changeKind === 'deleted') return 'Deleted';
  return 'Edited';
}

function displayPath(path: string, cwd: string) {
  if (!isAbsolute(path)) return path;

  const absoluteCwd = cwd.startsWith('~/') ? `${homedir()}${cwd.slice(1)}` : cwd;
  const relativePath = relative(absoluteCwd, path);
  if (relativePath && !relativePath.startsWith('..') && !isAbsolute(relativePath))
    return relativePath;
  return formatWorkspacePath(path);
}

export function renderDiffSummaryHeader(files: FileChange[], ctx: RenderContext): StyledLine {
  const sortedFiles = [...files].sort((left, right) => left.path.localeCompare(right.path));
  if (sortedFiles.length === 1) {
    const file = sortedFiles[0];
    const counts = lineCounts(file);
    return line(
      span('• ', ctx.theme.dimmed),
      span(changeVerb(file), chalk.bold),
      span(' '),
      span(displayPath(file.path, ctx.cwd)),
      span(' '),
      ...countSummary(counts.added, counts.removed),
    );
  }

  const totals = sortedFiles.reduce(
    (sum, file) => {
      const counts = lineCounts(file);
      sum.added += counts.added;
      sum.removed += counts.removed;
      return sum;
    },
    { added: 0, removed: 0 },
  );
  const noun = sortedFiles.length === 1 ? 'file' : 'files';
  return line(
    span('• ', ctx.theme.dimmed),
    span('Edited', chalk.bold),
    span(` ${sortedFiles.length} ${noun} `),
    ...countSummary(totals.added, totals.removed),
  );
}

function lineNumberWidth(hunks: ParsedDiffHunk[]) {
  const maxLineNumber = hunks
    .flatMap(hunk => hunk.lines)
    .reduce(
      (maximum, diffLine) =>
        Math.max(maximum, diffLine.oldLineNumber ?? 0, diffLine.newLineNumber ?? 0),
      0,
    );
  return Math.max(1, String(maxLineNumber).length);
}

function wrapSegments(segments: Segment[], maxColumns: number): Segment[][] {
  const width = Math.max(1, maxColumns);
  const output: Segment[][] = [];
  let current: Segment[] = [];
  let currentWidth = 0;

  const append = (text: string, style?: Style) => {
    if (!text) return;
    const previous = current[current.length - 1];
    if (previous && previous.style === style) previous.text += text;
    else current.push(span(text, style));
  };
  const flush = () => {
    output.push(current);
    current = [];
    currentWidth = 0;
  };

  for (const segment of segments) {
    if (isPrintableAscii(segment.text)) {
      let offset = 0;
      while (offset < segment.text.length) {
        const available = width - currentWidth;
        if (available === 0) {
          flush();
          continue;
        }
        const end = Math.min(segment.text.length, offset + available);
        append(segment.text.slice(offset, end), segment.style);
        currentWidth += end - offset;
        offset = end;
        if (currentWidth >= width) flush();
      }
      continue;
    }

    for (const sourceCharacter of Array.from(segment.text)) {
      const text = sourceCharacter === '\t' ? '    ' : sourceCharacter;
      const characterWidth = Math.max(1, widthOf(text));
      if (currentWidth > 0 && currentWidth + characterWidth > width) flush();
      append(text, segment.style);
      currentWidth += characterWidth;
      if (currentWidth >= width) flush();
    }
  }

  if (current.length > 0 || output.length === 0) output.push(current);
  return output;
}

function backgroundStyle(kind: DiffLineKind, ctx: RenderContext): Style | undefined {
  const colorLevel = chalk.level ?? 0;
  if (kind === 'context' || colorLevel < 2) return undefined;

  const light = ctx.theme.isLight();
  if (colorLevel === 2) {
    const index = light
      ? kind === 'insert' ? 194 : 224
      : kind === 'insert' ? 22 : 52;
    return value => chalk.bgAnsi256(index)(value);
  }
  const color = light
    ? kind === 'insert' ? LIGHT_ADD_BACKGROUND : LIGHT_DELETE_BACKGROUND
    : kind === 'insert' ? DARK_ADD_BACKGROUND : DARK_DELETE_BACKGROUND;
  return value => chalk.bgHex(color)(value);
}

function gutterStyle(kind: DiffLineKind, ctx: RenderContext): Style | undefined {
  const colorLevel = chalk.level ?? 0;
  if (kind === 'context' || !ctx.theme.isLight() || colorLevel < 2) return ctx.theme.dimmed;

  if (colorLevel === 2) {
    const background = kind === 'insert' ? 157 : 217;
    return value => chalk.ansi256(236).bgAnsi256(background)(value);
  }
  const background = kind === 'insert'
    ? LIGHT_ADD_GUTTER_BACKGROUND
    : LIGHT_DELETE_GUTTER_BACKGROUND;
  return value => chalk.hex(LIGHT_GUTTER_FOREGROUND).bgHex(background)(value);
}

function signStyle(kind: DiffLineKind): Style | undefined {
  if (kind === 'insert') return chalk.green;
  if (kind === 'delete') return chalk.red;
  return undefined;
}

function codeSegments(
  diffLine: ParsedDiffLine,
  highlighted: Segment[] | undefined,
  ctx: RenderContext,
) {
  const segments = highlighted?.map(segment => ({ ...segment })) ?? [span(diffLine.text)];
  const colorLevel = chalk.level ?? 0;

  return segments.map(segment => {
    const fallbackDiffStyle = highlighted
      ? undefined
      : diffLine.kind === 'insert'
        ? (!ctx.theme.isLight() || colorLevel < 2 ? chalk.green : undefined)
        : diffLine.kind === 'delete'
          ? (!ctx.theme.isLight() || colorLevel < 2 ? chalk.red : undefined)
          : undefined;
    const deletionOverlay = highlighted && diffLine.kind === 'delete' ? ctx.theme.dimmed : undefined;
    return span(
      segment.text,
      composeStyles(segment.style, fallbackDiffStyle, deletionOverlay),
    );
  });
}

function renderDiffLine(
  diffLine: ParsedDiffLine,
  highlighted: Segment[] | undefined,
  numberWidth: number,
  innerWidth: number,
  ctx: RenderContext,
): Block {
  const number = diffLine.kind === 'delete'
    ? diffLine.oldLineNumber
    : diffLine.newLineNumber;
  const availableContentWidth = Math.max(1, innerWidth - numberWidth - 2);
  const chunks = wrapSegments(
    codeSegments(diffLine, highlighted, ctx),
    availableContentWidth,
  );
  const lineBackground = backgroundStyle(diffLine.kind, ctx);

  return chunks.map((chunk, index) => {
    const gutter = index === 0
      ? `${String(number ?? '').padStart(numberWidth, ' ')} `
      : `${''.padStart(numberWidth, ' ')}  `;
    const segments = [
      span(gutter, gutterStyle(diffLine.kind, ctx)),
      ...(index === 0
        ? [span(diffLine.kind === 'insert' ? '+' : diffLine.kind === 'delete' ? '-' : ' ', signStyle(diffLine.kind))]
        : []),
      ...chunk,
    ];
    let rendered = serializeSegments(segments);
    if (lineBackground) {
      const visibleWidth = segments.reduce((total, segment) => total + widthOf(segment.text), 0);
      const padding = ' '.repeat(Math.max(0, innerWidth - visibleWidth));
      rendered = lineBackground(`${rendered}${padding}`);
    }
    return rawLine(`    ${rendered}`);
  });
}

function renderFileDiff(file: FileChange, ctx: RenderContext): Block {
  const hunks = parseUnifiedDiff(file.diff);
  if (hunks.length === 0) return [];

  const detectedLanguage = codeLanguageForPath(file.path);
  const language = detectedLanguage && !exceedsSyntaxHighlightLimits(file.diff)
    ? detectedLanguage
    : null;
  const numberWidth = lineNumberWidth(hunks);
  const innerWidth = Math.max(1, ctx.width - 5);
  const output: Block = [];

  hunks.forEach((hunk, hunkIndex) => {
    if (hunkIndex > 0) {
      output.push(
        line(
          span('    '),
          span(`${''.padStart(numberWidth, ' ')} `, ctx.theme.dimmed),
          span('⋮', ctx.theme.dimmed),
        ),
      );
    }

    const highlightedLines = language
      ? highlightedCodeLines(hunk.lines.map(diffLine => diffLine.text).join('\n'), language, ctx)
      : null;
    const hasAlignedHighlighting = highlightedLines?.length === hunk.lines.length;
    hunk.lines.forEach((diffLine, lineIndex) => {
      const highlighted = hasAlignedHighlighting && highlightedLines[lineIndex]?.type === 'styled'
        ? highlightedLines[lineIndex].segments
        : undefined;
      output.push(
        ...renderDiffLine(
          diffLine,
          highlighted,
          numberWidth,
          innerWidth,
          ctx,
        ),
      );
    });
  });

  return output;
}

export function renderFileChanges(
  fileChanges: FileChange[],
  ctx: RenderContext,
  options: { maxLinesPerFile?: number; showFileHeaders?: boolean } = {},
): Block {
  const block: Block = [];
  const showFileHeaders = options.showFileHeaders ?? true;
  const sortedFiles = [...fileChanges].sort((left, right) => left.path.localeCompare(right.path));

  sortedFiles.forEach((file, index) => {
    if (index > 0) block.push(blankLine());

    const counts = lineCounts(file);
    if (showFileHeaders) {
      block.push(
        line(
          span('  └ ', ctx.theme.dimmed),
          span(displayPath(file.path, ctx.cwd)),
          span(' '),
          ...countSummary(counts.added, counts.removed),
        ),
      );
    }

    const renderedDiff = renderFileDiff(file, ctx);
    const visibleDiff = options.maxLinesPerFile === undefined
      ? renderedDiff
      : renderedDiff.slice(0, options.maxLinesPerFile);
    block.push(...visibleDiff);
    if (visibleDiff.length < renderedDiff.length) {
      block.push(
        line(
          span('    '),
          span(
            `… +${renderedDiff.length - visibleDiff.length} diff lines (ctrl + t to view transcript)`,
            ctx.theme.dimmed,
          ),
        ),
      );
    }
  });

  return block;
}
