import chalk from 'chalk';

import { EntryKind, type HistoryEntry } from '@/types';
import { widthOf } from '@/text';
import { LEFT_MARGIN, indent, thinPanelize, wrapTextBlock } from '../layout';
import { renderMarkdown } from '../markdown';
import { blankLine, line, rawBlock, span } from '../primitives';
import { renderToolHistoryEntry } from './tools';

import type { Block, RenderContext, Style, StyledLine } from '../types';

export type HistoryEntryRenderOptions = {
  animateAssistant?: boolean;
};

function renderUserEntry(text: string, ctx: RenderContext): Block {
  return thinPanelize(wrapTextBlock(text, Math.max(1, ctx.width - 2), ctx.theme.foreground), {
    bg: ctx.theme.panelBg(),
    width: ctx.width,
  });
}

const RAINBOW_PHRASE_PATTERN = /you'?re absolutely right/gi;
const AMP_RAINBOW_COLORS = [
  null,
  [252, 228, 165],
  [156, 232, 150],
  [104, 205, 244],
  [128, 176, 255],
  [248, 186, 235],
] as const;
const AMP_RAINBOW_WIDTH = 8;
const AMP_RAINBOW_CYCLE_MS = 3_000;
const AMP_RAINBOW_ANIMATION_MS = 2_000;

function ampRainbowStyle(position: { index: number; total: number }, now: number) {
  const cycleOffset = now % AMP_RAINBOW_CYCLE_MS;
  if (cycleOffset >= AMP_RAINBOW_ANIMATION_MS) return null;

  const animationOffset = cycleOffset / AMP_RAINBOW_ANIMATION_MS;
  const startPos =
    Math.floor(animationOffset * (position.total + AMP_RAINBOW_WIDTH)) - AMP_RAINBOW_WIDTH;
  if (position.index < startPos || position.index >= startPos + AMP_RAINBOW_WIDTH) return null;

  const color = AMP_RAINBOW_COLORS[(position.index - startPos) % AMP_RAINBOW_COLORS.length];
  if (!color) return null;

  const [r, g, b] = color;
  return (value: string) => chalk.rgb(r, g, b)(value);
}

function renderAssistantLines(text: string, ctx: RenderContext, animate = false) {
  const width = Math.max(1, ctx.width - 2);
  const lines: StyledLine[] = [];
  const now = Date.now();

  RAINBOW_PHRASE_PATTERN.lastIndex = 0;
  const ranges = animate
    ? Array.from(text.matchAll(RAINBOW_PHRASE_PATTERN)).map(match => {
        const start = match.index ?? 0;
        return {
          start,
          end: start + match[0].length,
          total: match[0].replace(/\s/g, '').length,
        };
      })
    : [];

  let segments: StyledLine['segments'] = [];
  let currentWidth = 0;
  let charIndex = 0;

  const flushLine = (allowEmpty = false) => {
    if (segments.length === 0 && !allowEmpty) return;
    lines.push(line(...segments));
    segments = [];
    currentWidth = 0;
  };

  for (const ch of Array.from(text)) {
    if (ch === '\n') {
      flushLine(true);
      charIndex += ch.length;
      continue;
    }

    const charWidth = Math.max(1, widthOf(ch));
    if (segments.length > 0 && currentWidth + charWidth > width) flushLine();

    const range = ranges.find(
      candidate => charIndex >= candidate.start && charIndex < candidate.end,
    );
    const style = (() => {
      if (!range || /\s/.test(ch)) return ctx.theme.foreground;

      const relativeText = text.slice(range.start, charIndex + ch.length);
      const nonWhitespaceIndex = relativeText.replace(/\s/g, '').length - 1;
      return (
        ampRainbowStyle({ index: nonWhitespaceIndex, total: range.total }, now) ??
        ctx.theme.foreground
      );
    })();

    segments.push(span(ch, style));
    currentWidth += charWidth;
    charIndex += ch.length;
  }

  flushLine(true);
  return lines;
}

function composeStyles(...styles: Array<Style | undefined>): Style | undefined {
  const active = styles.filter(Boolean) as Style[];
  if (active.length === 0) return undefined;
  return value => active.reduce((out, style) => style(out), value);
}

function styleBlock(block: Block, style: Style): Block {
  return block.map(entry => {
    if (entry.type === 'raw') return line(span(entry.text, style));
    return line(...entry.segments.map(segment => span(segment.text, composeStyles(segment.style, style))));
  });
}

function renderAssistantEntry(text: string, ctx: RenderContext, animate = false): Block {
  if (animate) return indent(renderAssistantLines(text, ctx, true), LEFT_MARGIN);
  return indent(renderMarkdown(text, ctx, Math.max(1, ctx.width - 2)), LEFT_MARGIN);
}

function renderReasoningEntry(text: string, ctx: RenderContext): Block {
  const style = (value: string) => chalk.italic(ctx.theme.dimmed(value));
  return indent(styleBlock(renderMarkdown(text, ctx, Math.max(1, ctx.width - 2)), style), LEFT_MARGIN);
}

function renderShellEntry(text: string, ctx: RenderContext): Block {
  const match = text.match(/^(.*?)(\s+exit\s+\d+)$/);

  if (!match) {
    return indent(
      wrapTextBlock(text, Math.max(1, ctx.width - 4), ctx.theme.foreground),
      [span(LEFT_MARGIN), span('$ ', ctx.theme.dimmed)],
      `${LEFT_MARGIN}  `,
    );
  }

  const [, command, exitText] = match;
  const availableWidth = Math.max(1, ctx.width - 4);
  const commandLines = wrapTextBlock(command, availableWidth, ctx.theme.foreground);
  const lastLine = commandLines.pop();

  if (!lastLine) {
    return indent(
      wrapTextBlock(text, availableWidth, ctx.theme.foreground),
      [span(LEFT_MARGIN), span('$ ', ctx.theme.dimmed)],
      `${LEFT_MARGIN}  `,
    );
  }

  const block = [...commandLines, line(...lastLine.segments, span(exitText, ctx.theme.dimmed))];

  return indent(block, [span(LEFT_MARGIN), span('$ ', ctx.theme.dimmed)], `${LEFT_MARGIN}  `);
}

function renderErrorEntry(text: string, ctx: RenderContext): Block {
  return indent(
    wrapTextBlock(text, Math.max(1, ctx.width - 4), chalk.redBright),
    [span(LEFT_MARGIN), span('! ', chalk.red)],
    `${LEFT_MARGIN}  `,
  );
}

function renderToolEntry(text: string, ctx: RenderContext): Block {
  return indent(
    wrapTextBlock(text, Math.max(1, ctx.width - 5), ctx.theme.dimmed),
    [span(LEFT_MARGIN), span('· ', ctx.theme.dimmed), span(' ')],
    `${LEFT_MARGIN}   `,
  );
}

function renderMetaEntry(text: string, ctx: RenderContext): Block {
  const style =
    text === '(steered)'
      ? (value: string) => chalk.italic(ctx.theme.dimmed(value))
      : ctx.theme.dimmed;
  return indent(wrapTextBlock(text, Math.max(1, ctx.width - 2), style), LEFT_MARGIN);
}

function renderCompactedEntry(
  entry: Extract<HistoryEntry, { type: 'compacted' }>,
  ctx: RenderContext,
): Block {
  const width = Math.max(1, ctx.width - 4);
  const summaryLines = entry.summary
    .split('\n')
    .slice(0, 10)
    .flatMap(text => wrapTextBlock(text, width, ctx.theme.dimmed));

  return thinPanelize(
    [
      line(
        span('Compacted', chalk.yellow),
        span(' · ', ctx.theme.subtle),
        span(
          `${entry.previousMessageCount} → ${entry.nextMessageCount} messages`,
          ctx.theme.dimmed,
        ),
        span(' · ', ctx.theme.subtle),
        span(entry.automatic ? 'auto' : 'manual', ctx.theme.dimmed),
      ),
      blankLine(),
      ...summaryLines,
    ],
    {
      bg: ctx.theme.panelBg(),
      width: ctx.width,
    },
  );
}

export function renderHistoryEntry(
  entry: HistoryEntry,
  ctx: RenderContext,
  options: HistoryEntryRenderOptions = {},
): Block {
  if (entry.type === 'tool') return renderToolHistoryEntry(entry, ctx);
  if (entry.type === 'compacted') return renderCompactedEntry(entry, ctx);
  if (entry.type === 'ansi') return indent(rawBlock(entry.text), LEFT_MARGIN);
  if (entry.type === 'plain')
    return indent(wrapTextBlock(entry.text, Math.max(1, ctx.width)), LEFT_MARGIN);

  if (entry.kind === EntryKind.User) return renderUserEntry(entry.text, ctx);
  if (entry.kind === EntryKind.Assistant)
    return renderAssistantEntry(entry.text, ctx, options.animateAssistant);
  if (entry.kind === EntryKind.Reasoning) return renderReasoningEntry(entry.text, ctx);
  if (entry.kind === EntryKind.Shell) return renderShellEntry(entry.text, ctx);
  if (entry.kind === EntryKind.Error) return renderErrorEntry(entry.text, ctx);
  if (entry.kind === EntryKind.Tool) return renderToolEntry(entry.text, ctx);

  return renderMetaEntry(entry.text, ctx);
}
