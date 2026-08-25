import chalk from 'chalk';

import { repeat, widthOf } from '@/text';
import { thinPanelize } from '../layout';
import { line, span } from '../primitives';

import type { ComposerRenderResult, RenderContext, Segment, StyledLine } from '../types';

export type ComposerState = {
  inputChars: string[];
  pasteRanges: Array<{ start: number; end: number }>;
  cursor: number;
  scrollOffset?: number;
  slashCommandLength?: number;
  showCapabilitiesHint?: boolean;
};

function adjustComposerState(state: ComposerState) {
  const shellMode = state.inputChars[0] === '!';
  const slashMode = state.inputChars[0] === '/';
  const hiddenPrefix = shellMode || slashMode ? 1 : 0;

  if (!hiddenPrefix) return { hiddenPrefix, inputState: state };

  return {
    hiddenPrefix,
    inputState: {
      ...state,
      inputChars: state.inputChars.slice(1),
      pasteRanges: state.pasteRanges.flatMap(range => {
        if (range.end <= 1) return [];
        return [{ start: Math.max(0, range.start - 1), end: range.end - 1 }];
      }),
      cursor: Math.max(0, state.cursor - 1),
    },
  };
}

function charWidth(ch: string) {
  return Math.max(1, widthOf(ch));
}

function renderInputLines(
  state: ComposerState,
  viewWidth: number,
  charStyleAt?: (index: number, ch: string) => ((text: string) => string) | undefined,
) {
  const lines: StyledLine[] = [];
  let segments: StyledLine['segments'] = [];
  let currentWidth = 0;
  const pasteRanges = [...state.pasteRanges].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );

  const flushLine = (allowEmpty = false) => {
    if (segments.length === 0 && !allowEmpty) return;
    lines.push(line(...segments));
    segments = [];
    currentWidth = 0;
  };

  const pushChar = (text: string, style?: (text: string) => string) => {
    const width = charWidth(text);

    if (segments.length > 0 && currentWidth + width > viewWidth) flushLine();

    segments.push(span(text, style));
    currentWidth += width;
  };

  let pasteIndex = 0;
  let pasteCount = 0;

  for (let index = 0; index < state.inputChars.length; index += 1) {
    const range = pasteRanges[pasteIndex];

    if (range && index === range.start) {
      pasteCount += 1;
      const extraLines = state.inputChars
        .slice(range.start, range.end)
        .filter(ch => ch === '\n').length;
      const label = `[paste #${pasteCount} +${extraLines} lines]`;
      pushChar(
        label,
        state.cursor >= range.start && state.cursor < range.end ? chalk.inverse : undefined,
      );
      index = range.end - 1;
      pasteIndex += 1;
      continue;
    }

    const ch = state.inputChars[index];

    if (index === state.cursor && ch === '\n') {
      pushChar(' ', chalk.inverse);
      flushLine(true);
      continue;
    }

    if (ch === '\n') {
      flushLine(true);
      continue;
    }

    pushChar(ch, index === state.cursor ? chalk.inverse : charStyleAt?.(index, ch));
  }

  if (state.cursor >= state.inputChars.length) pushChar(' ', chalk.inverse);
  if (segments.length === 0) segments.push(span(' ', chalk.inverse));

  flushLine();
  return lines;
}

type CursorPoint = { row: number; col: number };

function buildCursorMap(state: ComposerState, viewWidth: number) {
  const positions: CursorPoint[] = Array.from({ length: state.inputChars.length + 1 }, () => ({
    row: 0,
    col: 0,
  }));
  const pasteRanges = [...state.pasteRanges].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  let pasteIndex = 0;
  let pasteCount = 0;
  let row = 0;
  let col = 0;

  const placeToken = (start: number, end: number, text: string) => {
    let tokenRow = row;
    let tokenCol = col;
    const tokenWidth = charWidth(text);

    if (tokenCol > 0 && tokenCol + tokenWidth > viewWidth) {
      tokenRow += 1;
      tokenCol = 0;
    }

    for (let index = start; index < end; index += 1)
      positions[index] = { row: tokenRow, col: tokenCol };
    row = tokenRow;
    col = tokenCol + tokenWidth;
    positions[end] = { row, col };
  };

  for (let index = 0; index < state.inputChars.length; index += 1) {
    const range = pasteRanges[pasteIndex];

    if (range && index === range.start) {
      pasteCount += 1;
      const extraLines = state.inputChars
        .slice(range.start, range.end)
        .filter(ch => ch === '\n').length;
      placeToken(range.start, range.end, `[paste #${pasteCount} +${extraLines} lines]`);
      index = range.end - 1;
      pasteIndex += 1;
      continue;
    }

    const ch = state.inputChars[index];

    if (ch === '\n') {
      positions[index] = { row, col };
      row += 1;
      col = 0;
      positions[index + 1] = { row, col };
      continue;
    }

    placeToken(index, index + 1, ch);
  }

  return positions;
}

function renderComposerPrompt(
  state: ComposerState,
  ctx: RenderContext,
  shellMode: boolean,
  slashMode: boolean,
  validSlashCommand: boolean,
): Segment {
  if (state.inputChars.length === 0) return span('→', ctx.theme.dimmed);
  if (shellMode) return span('!', chalk.yellow);
  if (slashMode) return span('/', validSlashCommand ? chalk.cyanBright : ctx.theme.foreground);
  return span('→', ctx.theme.foreground);
}

export function moveComposerCursorVertical(
  state: ComposerState,
  viewWidth: number,
  delta: number,
  preferredColumn?: number,
) {
  const { hiddenPrefix, inputState } = adjustComposerState(state);
  const positions = buildCursorMap(inputState, viewWidth);
  const current = positions[Math.max(0, Math.min(inputState.cursor, positions.length - 1))] ?? {
    row: 0,
    col: 0,
  };
  const targetRow = current.row + delta;
  if (targetRow < 0) return null;

  const targetCol = preferredColumn ?? current.col;
  let bestIndex: number | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let index = 0; index < positions.length; index += 1) {
    const point = positions[index];
    if (point.row !== targetRow) continue;

    const distance = Math.abs(point.col - targetCol);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  }

  if (bestIndex === null) return null;

  return {
    cursor: bestIndex + hiddenPrefix,
    preferredColumn: targetCol,
  };
}

export function renderComposer(state: ComposerState, ctx: RenderContext): ComposerRenderResult {
  const contentWidth = Math.max(1, ctx.width - 4);
  const shellMode = state.inputChars[0] === '!';
  const slashMode = state.inputChars[0] === '/';
  const validSlashCommand = slashMode && (state.slashCommandLength ?? 0) > 0;
  const capabilitiesHint = state.showCapabilitiesHint ? '/ commands · @ files · ! shell' : '';
  const capabilitiesWidth = widthOf(capabilitiesHint);
  const prompt = renderComposerPrompt(state, ctx, shellMode, slashMode, validSlashCommand);
  const promptWidth = widthOf(prompt.text);
  const hintWidth = capabilitiesHint ? capabilitiesWidth + 1 : 0;
  const placeholderFill = (occupiedWidth: number) =>
    repeat(' ', Math.max(0, contentWidth + 1 - occupiedWidth - hintWidth));

  if (state.inputChars.length === 0) {
    const label = 'Plan, search, build anything';
    const fill = placeholderFill(promptWidth + 1 + widthOf(label));

    return {
      block: thinPanelize(
        [
          line(
            prompt,
            span(' '),
            span('P', chalk.inverse),
            span(label.slice(1), ctx.theme.dimmed),
            span(fill),
            ...(capabilitiesHint ? [span(' '), span(capabilitiesHint, ctx.theme.dimmed)] : []),
          ),
        ],
        {
          bg: ctx.theme.composerBg(),
          width: ctx.width,
        },
      ),
    };
  }

  if (shellMode && state.inputChars.length === 1) {
    const label = 'Run a command — e.g., npm install';
    const fill = placeholderFill(promptWidth + 2 + widthOf(label));

    return {
      block: thinPanelize(
        [
          line(
            prompt,
            span(' '),
            span(' ', chalk.inverse),
            span(label, ctx.theme.dimmed),
            span(fill),
            ...(capabilitiesHint ? [span(' '), span(capabilitiesHint, ctx.theme.dimmed)] : []),
          ),
        ],
        {
          bg: ctx.theme.composerBg(),
          width: ctx.width,
        },
      ),
    };
  }

  if (slashMode && state.inputChars.length === 1) {
    const fill = placeholderFill(promptWidth + 2);

    return {
      block: thinPanelize(
        [
          line(
            prompt,
            span(' '),
            span(' ', chalk.inverse),
            span(fill),
            ...(capabilitiesHint ? [span(' '), span(capabilitiesHint, ctx.theme.dimmed)] : []),
          ),
        ],
        {
          bg: ctx.theme.composerBg(),
          width: ctx.width,
        },
      ),
    };
  }

  const { inputState } = adjustComposerState(state);
  const inputLines = renderInputLines(
    inputState,
    contentWidth,
    slashMode
      ? index => (index < (state.slashCommandLength ?? 0) ? chalk.cyanBright : undefined)
      : undefined,
  );
  const block = inputLines.map((entry, index) =>
    line(
      ...(index === 0 ? [prompt, span(' '), ...entry.segments] : [span('  '), ...entry.segments]),
    ),
  );

  return {
    block: thinPanelize(block, { bg: ctx.theme.composerBg(), width: ctx.width }),
  };
}
