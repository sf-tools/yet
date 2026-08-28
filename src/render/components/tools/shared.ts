import chalk from 'chalk';

import { plain, truncateToWidth, widthOf } from '@/text';
import { highlightedCodeBlock } from '@/render/markdown';
import { panelize, wrapTextBlock } from '@/render/layout';
import { blankLine, line, span } from '@/render/primitives';
import type { Block, RenderContext } from '@/render/types';
import type { ToolHistoryEntry } from '@/types';

export { renderFileChanges } from '@/render/diff';

export type ToolRenderer = (entry: ToolHistoryEntry, ctx: RenderContext) => Block;

type ToolCardOptions = {
  name: string;
  detail?: string;
  body?: string[];
  bodyBlock?: Block;
  status: ToolHistoryEntry['status'];
};

export function asRecord(value: unknown) {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

export function stringProp(value: unknown, key: string) {
  const record = asRecord(value);
  return record && typeof record[key] === 'string' ? record[key] : null;
}

export function numberProp(value: unknown, key: string) {
  const record = asRecord(value);
  return record && typeof record[key] === 'number' ? record[key] : null;
}

export function arrayProp(value: unknown, key: string) {
  const record = asRecord(value);
  return record && Array.isArray(record[key]) ? record[key] : null;
}

export function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function previewLines(lines: string[], ctx: RenderContext, maxLines = 6, label = 'lines') {
  if (ctx.transcriptMode || lines.length <= maxLines) return lines;

  return [
    ...lines.slice(0, maxLines),
    `… +${lines.length - maxLines} ${label} (ctrl + t to view transcript)`,
  ];
}

export function previewText(text: string, ctx: RenderContext, maxLines = 6, label = 'lines') {
  return previewLines(plain(text).split('\n'), ctx, maxLines, label);
}

export function previewJson(value: unknown, ctx: RenderContext) {
  try {
    return previewText(JSON.stringify(value, null, 2), ctx, 8);
  } catch {
    return [String(value)];
  }
}

export function previewCodeBlock(
  text: string,
  language: string | null,
  ctx: RenderContext,
  maxLines = 8,
  label = 'lines',
): Block {
  const highlighted = highlightedCodeBlock(text, language, ctx);
  const visible = ctx.transcriptMode ? highlighted : highlighted.slice(0, maxLines);

  if (highlighted.length > visible.length) {
    return [
      ...visible,
      line(
        span(
          `… +${highlighted.length - visible.length} ${label} (ctrl + t to view transcript)`,
          ctx.theme.dimmed,
        ),
      ),
    ];
  }

  return visible;
}

export function renderToolCard(
  { name, detail, body = [], bodyBlock = [], status }: ToolCardOptions,
  ctx: RenderContext,
): Block {
  const statusStyle =
    status === 'failed'
      ? chalk.redBright
      : status === 'running'
        ? ctx.theme.spinnerText
        : ctx.theme.dimmed;
  const statusLabel = status === 'failed' ? 'failed' : status === 'running' ? 'running' : 'done';
  const bodyStyle = status === 'failed' ? chalk.redBright : ctx.theme.dimmed;
  const width = Math.max(1, ctx.width - 4);
  const headerPrefixWidth = widthOf(`⌁ ${name}`);
  const headerSuffixWidth = widthOf(` · ${statusLabel}`);
  const detailWidth = detail
    ? Math.max(0, width - headerPrefixWidth - headerSuffixWidth - widthOf(' · '))
    : 0;
  const visibleDetail = detail ? truncateToWidth(detail, detailWidth) : '';

  const header = line(
    span('⌁ ', ctx.theme.subtle),
    span(name, ctx.theme.foreground),
    ...(visibleDetail
      ? [span(' · ', ctx.theme.subtle), span(visibleDetail, ctx.theme.dimmed)]
      : []),
    span(' · ', ctx.theme.subtle),
    span(statusLabel, statusStyle),
  );

  const textBodyBlock = body.flatMap(text =>
    wrapTextBlock(text, width, bodyStyle).map(part => line(span('  '), ...part.segments)),
  );
  const combinedBody = [
    ...textBodyBlock,
    ...(textBodyBlock.length > 0 && bodyBlock.length > 0 ? [blankLine()] : []),
    ...bodyBlock,
  ];

  return panelize([header, ...combinedBody], { bg: ctx.theme.panelBg(), width: ctx.width });
}
