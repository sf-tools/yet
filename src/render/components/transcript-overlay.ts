import chalk from 'chalk';

import { EntryKind, type HistoryEntry, type ToolHistoryEntry } from '@/types';
import { repeat, truncateToWidth, widthOf } from '@/text';
import { renderHistoryEntry } from './entry';
import {
  isCommandToolEntry,
  renderCommandActivity,
} from './tools/command-activity';
import { blankLine, line, span } from '../primitives';
import type { Block, RenderContext } from '../types';

export function renderTranscriptContent(
  entries: HistoryEntry[],
  live: { reasoning: string; assistant: string },
  ctx: RenderContext,
): Block {
  return renderTranscriptDocument(entries, live, ctx).block;
}

export type TranscriptDocument = {
  block: Block;
  entryRanges: Map<number, { start: number; end: number }>;
};

export function renderTranscriptDocument(
  entries: HistoryEntry[],
  live: { reasoning: string; assistant: string },
  ctx: RenderContext,
  options: {
    highlightHistoryIndex?: number | null;
    cacheMarkdown?: boolean;
  } = {},
): TranscriptDocument {
  const sourceEntries = [...entries];
  if (live.reasoning.trim()) {
    sourceEntries.push({ type: 'entry', kind: EntryKind.Reasoning, text: live.reasoning });
  }
  if (live.assistant.trim()) {
    sourceEntries.push({ type: 'entry', kind: EntryKind.Assistant, text: live.assistant });
  }

  const out: Block = [];
  const entryRanges = new Map<number, { start: number; end: number }>();
  const transcriptContext = { ...ctx, transcriptMode: true };

  for (let index = 0; index < sourceEntries.length;) {
    const sourceStart = index;
    const entry = sourceEntries[index];
    let block: Block;
    if (entry.type === 'tool' && isCommandToolEntry(entry)) {
      let end = index + 1;
      while (
        end < sourceEntries.length &&
        sourceEntries[end].type === 'tool' &&
        isCommandToolEntry(sourceEntries[end] as ToolHistoryEntry)
      ) {
        end += 1;
      }
      block = renderCommandActivity(
        sourceEntries.slice(index, end) as ToolHistoryEntry[],
        transcriptContext,
        { transcript: true },
      );
      index = end;
    } else {
      block = renderHistoryEntry(entry, transcriptContext, {
        highlighted: index === options.highlightHistoryIndex,
        cacheMarkdown: options.cacheMarkdown,
      });
      index += 1;
    }

    if (block.length === 0) continue;
    if (out.length > 0) out.push(blankLine());
    const start = out.length;
    out.push(...block);
    for (let sourceIndex = sourceStart; sourceIndex < index && sourceIndex < entries.length; sourceIndex += 1)
      entryRanges.set(sourceIndex, { start, end: out.length });
  }
  return { block: out, entryRanges };
}

function titleLine(width: number, ctx: RenderContext) {
  const title = '/ T R A N S C R I P T ';
  const fill = repeat('/ ', Math.ceil(Math.max(0, width - widthOf(title)) / 2));
  return line(span(truncateToWidth(`${title}${fill}`, width), ctx.theme.dimmed));
}

function progressLine(width: number, percentage: number) {
  const suffix = ` ${percentage}% ─`;
  return line(
    span(repeat('─', Math.max(0, width - widthOf(suffix))), chalk.dim),
    span(suffix, chalk.dim),
  );
}

export function renderTranscriptViewport(
  content: Block,
  scrollOffset: number,
  ctx: RenderContext,
  options: { backtracking?: boolean } = {},
): { block: Block; maxScroll: number } {
  return renderTranscriptViewportParts([content], scrollOffset, ctx, options);
}

function sliceBlockParts(parts: readonly Block[], start: number, length: number) {
  const visible: Block = [];
  let offset = Math.max(0, start);
  let remaining = Math.max(0, length);

  for (const part of parts) {
    if (remaining === 0) break;
    if (offset >= part.length) {
      offset -= part.length;
      continue;
    }
    const slice = part.slice(offset, offset + remaining);
    visible.push(...slice);
    remaining -= slice.length;
    offset = 0;
  }

  return visible;
}

export function renderTranscriptViewportParts(
  contentParts: readonly Block[],
  scrollOffset: number,
  ctx: RenderContext,
  options: { backtracking?: boolean } = {},
): { block: Block; maxScroll: number } {
  const contentHeight = Math.max(1, ctx.height - 4);
  const contentLength = contentParts.reduce((total, part) => total + part.length, 0);
  const maxScroll = Math.max(0, contentLength - contentHeight);
  const clampedOffset = Math.max(0, Math.min(scrollOffset, maxScroll));
  const start = Math.max(0, maxScroll - clampedOffset);
  const visible = sliceBlockParts(contentParts, start, contentHeight);
  while (visible.length < contentHeight) visible.push(line());
  const percentage = maxScroll === 0
    ? 100
    : Math.max(0, Math.min(100, Math.round(((start + contentHeight) / contentLength) * 100)));

  return {
    block: [
      titleLine(ctx.width, ctx),
      ...visible,
      progressLine(ctx.width, percentage),
      line(span(' ↑/↓ to scroll   pgup/pgdn to page   home/end to jump', chalk.dim)),
      line(span(
        truncateToWidth(
          options.backtracking
            ? ' q to quit   esc/← to edit prev   → to edit next   enter to edit message'
            : ' q to quit   esc to edit prev',
          ctx.width,
        ),
        chalk.dim,
      )),
    ],
    maxScroll,
  };
}

export function renderTranscriptOverlay(
  entries: HistoryEntry[],
  live: { reasoning: string; assistant: string },
  scrollOffset: number,
  ctx: RenderContext,
): { block: Block; maxScroll: number } {
  return renderTranscriptViewport(renderTranscriptContent(entries, live, ctx), scrollOffset, ctx);
}
