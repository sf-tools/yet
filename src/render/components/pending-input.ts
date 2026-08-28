import chalk from 'chalk';

import { displayImageTokens } from '@/agent/image-tokens';
import { LEFT_MARGIN } from '../layout';
import { blankLine, line, span } from '../primitives';
import { widthOf } from '@/text';

import type { QueuedSubmission } from '@/store';
import type { Block, RenderContext, Segment, Style } from '../types';

const PREVIEW_LINE_LIMIT = 3;

type StyledCharacter = {
  text: string;
  style?: Style;
};

function isUrlLike(text: string) {
  return /^(?:https?:\/\/|www\.|localhost:\d+\/|(?:[\p{L}\p{N}-]+\.)+[\p{L}]{2,}(?:[/:?#]|$))/iu.test(
    text,
  );
}

function segmentRange(characters: StyledCharacter[], start: number, end: number): Segment[] {
  const segments: Segment[] = [];

  for (let index = start; index < end; index += 1) {
    const character = characters[index];
    const previous = segments.at(-1);
    if (previous && previous.style === character.style) previous.text += character.text;
    else segments.push(span(character.text, character.style));
  }

  return segments;
}

function splitRangeToWidth(
  characters: StyledCharacter[],
  start: number,
  end: number,
  width: number,
) {
  const ranges: Array<[number, number]> = [];
  let partStart = start;
  let partWidth = 0;

  for (let index = start; index < end; index += 1) {
    const characterWidth = Math.max(1, widthOf(characters[index].text));
    if (index > partStart && partWidth + characterWidth > width) {
      ranges.push([partStart, index]);
      partStart = index;
      partWidth = 0;
    }
    partWidth += characterWidth;
  }

  ranges.push([partStart, end]);
  return ranges;
}

function adaptiveWrapSegments(source: Segment[], width: number): Segment[][] {
  const availableWidth = Math.max(1, width);
  const characters = source.flatMap(segment =>
    Array.from(segment.text).map(text => ({ text, style: segment.style })),
  );
  if (characters.length === 0) return [[]];

  const words: Array<{ start: number; end: number; width: number; urlLike: boolean }> = [];
  for (let index = 0; index < characters.length; ) {
    while (index < characters.length && /\s/u.test(characters[index].text)) index += 1;
    if (index >= characters.length) break;

    const start = index;
    while (index < characters.length && !/\s/u.test(characters[index].text)) index += 1;
    const end = index;
    const text = characters.slice(start, end).map(character => character.text).join('');
    words.push({
      start,
      end,
      width: widthOf(text),
      urlLike: isUrlLike(text),
    });
  }
  if (words.length === 0) return [[]];

  const lines: Segment[][] = [];
  let lineStart = -1;
  let lineEnd = -1;
  let lineWidth = 0;

  const flushLine = () => {
    if (lineStart < 0) return;
    lines.push(segmentRange(characters, lineStart, lineEnd));
    lineStart = -1;
    lineEnd = -1;
    lineWidth = 0;
  };

  for (const word of words) {
    const gapWidth = lineEnd < 0
      ? 0
      : characters
          .slice(lineEnd, word.start)
          .reduce((total, character) => total + Math.max(1, widthOf(character.text)), 0);

    if (lineStart >= 0 && lineWidth + gapWidth + word.width <= availableWidth) {
      lineEnd = word.end;
      lineWidth += gapWidth + word.width;
      continue;
    }

    flushLine();
    if (word.width <= availableWidth || word.urlLike) {
      lineStart = word.start;
      lineEnd = word.end;
      lineWidth = word.width;
      continue;
    }

    const parts = splitRangeToWidth(characters, word.start, word.end, availableWidth);
    for (const [partStart, partEnd] of parts.slice(0, -1)) {
      lines.push(segmentRange(characters, partStart, partEnd));
    }
    const [partStart, partEnd] = parts.at(-1)!;
    lineStart = partStart;
    lineEnd = partEnd;
    lineWidth = widthOf(
      characters.slice(partStart, partEnd).map(character => character.text).join(''),
    );
  }

  flushLine();
  return lines;
}

function renderSectionHeader(
  title: string,
  hint: string | null,
  ctx: RenderContext,
): Block {
  const firstPrefix = [
    span(LEFT_MARGIN),
    span('• ', ctx.theme.dimmed),
  ];
  const restPrefix = [span(LEFT_MARGIN), span('  ', ctx.theme.dimmed)];
  const wrapped = adaptiveWrapSegments(
    [span(title), ...(hint ? [span(hint, ctx.theme.dimmed)] : [])],
    ctx.width - widthOf('• '),
  );

  return wrapped.map((segments, index) =>
    line(...(index === 0 ? firstPrefix : restPrefix), ...segments),
  );
}

function renderMessages(
  submissions: QueuedSubmission[],
  ctx: RenderContext,
  style: Style,
): Block {
  const block: Block = [];
  const firstPrefix = [span(LEFT_MARGIN), span('  ↳ ', ctx.theme.dimmed)];
  const restPrefix = [span(LEFT_MARGIN), span('    ')];
  const availableWidth = Math.max(1, ctx.width - widthOf('  ↳ '));

  for (const submission of submissions) {
    const text = displayImageTokens(submission.text.trim()) || '(empty message)';
    const wrapped = text
      .split('\n')
      .slice(0, PREVIEW_LINE_LIMIT + 1)
      .flatMap(part => adaptiveWrapSegments([span(part, style)], availableWidth));
    const visible = wrapped.slice(0, PREVIEW_LINE_LIMIT);

    for (let index = 0; index < visible.length; index += 1) {
      block.push(
        line(
          ...(index === 0 ? firstPrefix : restPrefix),
          ...visible[index],
        ),
      );
    }

    if (wrapped.length > PREVIEW_LINE_LIMIT) {
      block.push(line(...restPrefix, span('…', style)));
    }
  }

  return block;
}

export function renderPendingInput(
  pendingSteers: QueuedSubmission[],
  queuedSubmissions: QueuedSubmission[],
  ctx: RenderContext,
): Block {
  if (pendingSteers.length === 0 && queuedSubmissions.length === 0) return [];

  const block: Block = [];

  if (pendingSteers.length > 0) {
    block.push(
      ...renderSectionHeader(
        'Messages to be submitted after next tool call',
        ' (press esc to interrupt and send immediately)',
        ctx,
      ),
      ...renderMessages(pendingSteers, ctx, ctx.theme.dimmed),
    );
  }

  if (queuedSubmissions.length > 0) {
    if (block.length > 0) block.push(blankLine());
    const dimItalic = (text: string) => chalk.italic(ctx.theme.dimmed(text));
    block.push(
      ...renderSectionHeader('Queued follow-up inputs', null, ctx),
      ...renderMessages(queuedSubmissions, ctx, dimItalic),
      line(
        span(LEFT_MARGIN),
        span('    ⌥ + ↑ edit last queued message', ctx.theme.dimmed),
      ),
    );
  }

  return block;
}
