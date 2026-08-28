import chalk from 'chalk';

import { imageTokenRanges } from '@/agent/image-tokens';
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
  skillNames?: string[];
  showCapabilitiesHint?: boolean;
  placeholder?: string;
};

function adjustComposerState(state: ComposerState) {
  const shellMode = state.inputChars[0] === '!';
  const slashMode = state.inputChars[0] === '/';
  const mentionMode = state.inputChars[0] === '@';
  const skillMode = state.inputChars[0] === '$';
  const hiddenPrefix = shellMode || slashMode || mentionMode || skillMode ? 1 : 0;

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

function pasteLabel(inputChars: string[], range: { start: number; end: number }) {
  const lines = inputChars.slice(range.start, range.end).filter(ch => ch === '\n').length;
  return `[pasted +${lines} lines]`;
}

function renderInputLines(
  state: ComposerState,
  viewWidth: number,
  charStyleAt?: (index: number, ch: string) => ((text: string) => string) | undefined,
) {
  const lines: StyledLine[] = [];
  let segments: StyledLine['segments'] = [];
  let currentWidth = 0;
  const pasteRanges = [...state.pasteRanges].sort((left, right) => left.start - right.start || left.end - right.end);
  const imageRanges = imageTokenRanges(state.inputChars);

  const flushLine = (allowEmpty = false) => {
    if (segments.length === 0 && !allowEmpty) return;
    lines.push(line(...segments));
    segments = [];
    currentWidth = 0;
  };

  const pushChar = (text: string, style?: (text: string) => string) => {
    const displayText = text === '\t' ? ' ' : text;
    const width = charWidth(displayText);

    if (segments.length > 0 && currentWidth + width > viewWidth) flushLine();

    segments.push(span(displayText, style));
    currentWidth += width;
  };

  let pasteIndex = 0;
  let imageIndex = 0;

  for (let index = 0; index < state.inputChars.length; index += 1) {
    const range = pasteRanges[pasteIndex];

    if (range && index === range.start) {
      const label = pasteLabel(state.inputChars, range);
      const style = state.cursor >= range.start && state.cursor < range.end
        ? chalk.cyanBright.inverse
        : chalk.cyanBright;
      pushChar(label, style);
      index = range.end - 1;
      pasteIndex += 1;
      continue;
    }

    while (imageRanges[imageIndex] && imageRanges[imageIndex].end <= index) imageIndex += 1;
    const imageRange = imageRanges[imageIndex];
    if (imageRange && index === imageRange.start) {
      const style = state.cursor >= imageRange.start && state.cursor < imageRange.end
        ? chalk.cyanBright.inverse
        : chalk.cyanBright;
      pushChar(imageRange.label, style);
      index = imageRange.end - 1;
      imageIndex += 1;
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
  const pasteRanges = [...state.pasteRanges].sort((left, right) => left.start - right.start || left.end - right.end);
  const imageRanges = imageTokenRanges(state.inputChars);
  let pasteIndex = 0;
  let imageIndex = 0;
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

    for (let index = start; index < end; index += 1) positions[index] = { row: tokenRow, col: tokenCol };
    row = tokenRow;
    col = tokenCol + tokenWidth;
    positions[end] = { row, col };
  };

  for (let index = 0; index < state.inputChars.length; index += 1) {
    const range = pasteRanges[pasteIndex];

    if (range && index === range.start) {
      placeToken(range.start, range.end, pasteLabel(state.inputChars, range));
      index = range.end - 1;
      pasteIndex += 1;
      continue;
    }

    while (imageRanges[imageIndex] && imageRanges[imageIndex].end <= index) imageIndex += 1;
    const imageRange = imageRanges[imageIndex];
    if (imageRange && index === imageRange.start) {
      placeToken(imageRange.start, imageRange.end, imageRange.label);
      index = imageRange.end - 1;
      imageIndex += 1;
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
  mentionMode: boolean,
  skillMode: boolean,
  validSlashCommand: boolean,
): Segment {
  if (state.inputChars.length === 0) return span('→', ctx.theme.dimmed);
  if (shellMode) return span('!', chalk.yellow);
  if (slashMode) return span('/', validSlashCommand ? chalk.cyanBright : ctx.theme.foreground);
  if (mentionMode) return span('@', chalk.magentaBright);
  if (skillMode) return span('$', chalk.cyanBright);
  return span('→', ctx.theme.foreground);
}

export function moveComposerCursorVertical(state: ComposerState, viewWidth: number, delta: number, preferredColumn?: number) {
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
  const mentionMode = state.inputChars[0] === '@';
  const skillMode = state.inputChars[0] === '$';
  const compactPrefixMode = slashMode || mentionMode || skillMode;
  const validSlashCommand = slashMode && (state.slashCommandLength ?? 0) > 0;
  const capabilitiesHint = state.showCapabilitiesHint ? '/ commands · $ skills · @ files · ! shell' : '';
  const capabilitiesWidth = widthOf(capabilitiesHint);
  const prompt = renderComposerPrompt(state, ctx, shellMode, slashMode, mentionMode, skillMode, validSlashCommand);
  const promptWidth = widthOf(prompt.text);
  const hintWidth = capabilitiesHint ? capabilitiesWidth + 1 : 0;
  const placeholderFill = (occupiedWidth: number) => repeat(' ', Math.max(0, contentWidth + 1 - occupiedWidth - hintWidth));

  if (state.inputChars.length === 0) {
    const label = state.placeholder ?? 'Describe a task or ask a question';
    const [cursorCharacter = ' ', ...labelTail] = Array.from(label);
    const fill = placeholderFill(promptWidth + 1 + widthOf(label));

    return {
      block: thinPanelize(
        [
          line(
            prompt,
            span(' '),
            span(cursorCharacter, chalk.inverse),
            span(labelTail.join(''), ctx.theme.dimmed),
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
    const label = 'Run a shell command';
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

  if (compactPrefixMode && state.inputChars.length === 1) {
    const fill = placeholderFill(promptWidth + 1);

    return {
      block: thinPanelize(
        [line(prompt, span(' ', chalk.inverse), span(fill), ...(capabilitiesHint ? [span(' '), span(capabilitiesHint, ctx.theme.dimmed)] : []))],
        {
          bg: ctx.theme.composerBg(),
          width: ctx.width,
        },
      ),
    };
  }

  const { inputState } = adjustComposerState(state);
  const skillStyleIndices = new Set<number>();
  const inputText = inputState.inputChars.join('');
  for (const skillName of state.skillNames ?? []) {
    const targets = [`$${skillName}`];
    if (skillMode && inputText.startsWith(skillName)) {
      for (let index = 0; index < Array.from(skillName).length; index += 1) skillStyleIndices.add(index);
    }
    for (const target of targets) {
      let fromIndex = 0;
      while (fromIndex < inputText.length) {
        const matchIndex = inputText.indexOf(target, fromIndex);
        if (matchIndex === -1) break;

        const characterStart = Array.from(inputText.slice(0, matchIndex)).length;
        const characterLength = Array.from(target).length;
        for (let index = characterStart; index < characterStart + characterLength; index += 1) skillStyleIndices.add(index);
        fromIndex = matchIndex + target.length;
      }
    }
  }

  const tokenStyleAt = (index: number, char: string) => {
    if (skillStyleIndices.has(index)) return chalk.cyanBright;
    if (/\s/.test(char)) return undefined;

    let tokenStart = index;
    while (tokenStart > 0 && !/\s/.test(inputState.inputChars[tokenStart - 1])) tokenStart -= 1;

    if ((tokenStart === 0 && mentionMode) || inputState.inputChars[tokenStart] === '@') return chalk.magentaBright;
    if ((tokenStart === 0 && skillMode) || inputState.inputChars[tokenStart] === '$') return chalk.cyanBright;
    return undefined;
  };
  const inputLines = renderInputLines(
    inputState,
    contentWidth,
    slashMode ? index => (index < (state.slashCommandLength ?? 0) ? chalk.cyanBright : undefined) : tokenStyleAt,
  );
  const block = inputLines.map((entry, index) =>
    line(
      ...(index === 0
        ? [prompt, ...(compactPrefixMode ? [] : [span(' ')]), ...entry.segments]
        : [span(compactPrefixMode ? ' ' : '  '), ...entry.segments]),
    ),
  );

  return {
    block: thinPanelize(block, { bg: ctx.theme.composerBg(), width: ctx.width }),
  };
}
