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
  const sourceEntries = [...entries];
  if (live.reasoning.trim()) {
    sourceEntries.push({ type: 'entry', kind: EntryKind.Reasoning, text: live.reasoning });
  }
  if (live.assistant.trim()) {
    sourceEntries.push({ type: 'entry', kind: EntryKind.Assistant, text: live.assistant });
  }

  const out: Block = [];
  const transcriptContext = { ...ctx, transcriptMode: true };

  for (let index = 0; index < sourceEntries.length;) {
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
      block = renderHistoryEntry(entry, transcriptContext);
      index += 1;
    }

    if (block.length === 0) continue;
    if (out.length > 0) out.push(blankLine());
    out.push(...block);
  }
  return out;
}

function titleLine(width: number) {
  const title = '/ T R A N S C R I P T ';
  const fill = repeat('/ ', Math.ceil(Math.max(0, width - widthOf(title)) / 2));
  return line(span(truncateToWidth(`${title}${fill}`, width), chalk.bold));
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
): { block: Block; maxScroll: number } {
  const contentHeight = Math.max(1, ctx.height - 4);
  const maxScroll = Math.max(0, content.length - contentHeight);
  const clampedOffset = Math.max(0, Math.min(scrollOffset, maxScroll));
  const start = Math.max(0, maxScroll - clampedOffset);
  const visible = content.slice(start, start + contentHeight);
  while (visible.length < contentHeight) visible.push(line());
  const percentage = maxScroll === 0
    ? 100
    : Math.max(0, Math.min(100, Math.round(((start + contentHeight) / content.length) * 100)));

  return {
    block: [
      titleLine(ctx.width),
      ...visible,
      progressLine(ctx.width, percentage),
      line(span(' ↑/↓ to scroll   pgup/pgdn to page   home/end to jump', chalk.dim)),
      line(span(' q to quit   esc to edit prev', chalk.dim)),
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
