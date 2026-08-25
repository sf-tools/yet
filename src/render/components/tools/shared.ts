import chalk from 'chalk';
import { extname } from 'node:path';

import { plain, truncateToWidth, widthOf } from '@/text';
import { formatDiffStat } from '@/file-changes';
import { highlightedCodeBlock, normalizeCodeLanguage } from '@/render/markdown';
import { panelize, wrapTextBlock } from '@/render/layout';
import { blankLine, line, span } from '@/render/primitives';
import type { Block, RenderContext, StyledLine } from '@/render/types';
import type { FileChange, ToolHistoryEntry } from '@/types';

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
  if (ctx.expandPreviews || lines.length <= maxLines) {
    return lines.length > maxLines ? [...lines, '… (ctrl+o to collapse)'] : lines;
  }

  return [
    ...lines.slice(0, maxLines),
    `… (${lines.length - maxLines} more ${label}, ctrl+o to expand)`,
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

type ParsedDiffLine = {
  type: 'chunk' | 'add' | 'remove' | 'context';
  text: string;
  oldLineNum?: number;
  newLineNum?: number;
};

const FILE_LANGUAGE_ALIASES: Record<string, string> = {
  '.cjs': 'javascript',
  '.diff': 'diff',
  '.go': 'go',
  '.html': 'markup',
  '.htm': 'markup',
  '.js': 'javascript',
  '.json': 'json',
  '.jsx': 'jsx',
  '.md': 'markdown',
  '.mjs': 'javascript',
  '.py': 'python',
  '.rs': 'rust',
  '.sh': 'bash',
  '.sql': 'sql',
  '.toml': 'toml',
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.zsh': 'bash',
};

export function inferCodeLanguage(path: string) {
  return normalizeCodeLanguage(FILE_LANGUAGE_ALIASES[extname(path).toLowerCase()] ?? null);
}

export function previewCodeBlock(
  text: string,
  language: string | null,
  ctx: RenderContext,
  maxLines = 8,
  label = 'lines',
): Block {
  const highlighted = highlightedCodeBlock(text, language, ctx);
  const visible = ctx.expandPreviews ? highlighted : highlighted.slice(0, maxLines);

  if (highlighted.length > visible.length) {
    return [
      ...visible,
      line(
        span(
          `… (${highlighted.length - visible.length} more ${label}, ctrl+o to expand)`,
          ctx.theme.dimmed,
        ),
      ),
    ];
  }

  if (ctx.expandPreviews && highlighted.length > maxLines) {
    return [...visible, line(span('… (ctrl+o to collapse)', ctx.theme.dimmed))];
  }

  return visible;
}

function tintSegments(segments: StyledLine['segments'], style: (text: string) => string) {
  return segments.map(segment => ({
    ...segment,
    style: segment.style ? (text: string) => style(segment.style?.(text) ?? text) : style,
  }));
}

function parseDiffLines(diff: string): ParsedDiffLine[] {
  const lines = diff.split('\n');
  const parsed: ParsedDiffLine[] = [];
  let oldLineNum = 0;
  let newLineNum = 0;

  for (const rawLine of lines) {
    if (!rawLine || rawLine.startsWith('--- ') || rawLine.startsWith('+++ ')) continue;

    const chunkMatch = rawLine.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (chunkMatch) {
      oldLineNum = Number.parseInt(chunkMatch[1], 10);
      newLineNum = Number.parseInt(chunkMatch[2], 10);
      parsed.push({ type: 'chunk', text: rawLine });
      continue;
    }

    if (rawLine.startsWith('+')) {
      parsed.push({ type: 'add', text: rawLine.slice(1), newLineNum });
      newLineNum += 1;
      continue;
    }

    if (rawLine.startsWith('-')) {
      parsed.push({ type: 'remove', text: rawLine.slice(1), oldLineNum });
      oldLineNum += 1;
      continue;
    }

    parsed.push({
      type: 'context',
      text: rawLine.startsWith(' ') ? rawLine.slice(1) : rawLine,
      oldLineNum,
      newLineNum,
    });
    oldLineNum += 1;
    newLineNum += 1;
  }

  return parsed;
}

function lineNumberWidth(lines: ParsedDiffLine[]) {
  const maxLineNum = lines.reduce(
    (max, diffLine) => Math.max(max, diffLine.oldLineNum ?? 0, diffLine.newLineNum ?? 0),
    0,
  );
  return Math.max(3, String(maxLineNum || 0).length);
}

function formatLineNumber(lineNum: number | undefined, width: number) {
  return lineNum == null ? ''.padStart(width, ' ') : String(lineNum).padStart(width, ' ');
}

export function renderFileChanges(
  fileChanges: FileChange[],
  ctx: RenderContext,
  options: { maxLinesPerFile?: number } = {},
): Block {
  const block: Block = [];
  const maxLinesPerFile = options.maxLinesPerFile ?? Math.max(8, Math.min(24, ctx.height - 16));

  fileChanges.forEach((fileChange, index) => {
    if (index > 0) block.push(blankLine());

    const statText = formatDiffStat(fileChange.stats);
    block.push(
      line(
        span('  ', ctx.theme.subtle),
        span(fileChange.path, ctx.theme.foreground),
        ...(statText
          ? [
              span(' · ', ctx.theme.subtle),
              ...(fileChange.stats.added > 0
                ? [span(`+${fileChange.stats.added}`, chalk.greenBright)]
                : []),
              ...(fileChange.stats.modified > 0
                ? [
                    span(
                      `${fileChange.stats.added > 0 ? ' ' : ''}~${fileChange.stats.modified}`,
                      chalk.yellowBright,
                    ),
                  ]
                : []),
              ...(fileChange.stats.removed > 0
                ? [
                    span(
                      `${fileChange.stats.added > 0 || fileChange.stats.modified > 0 ? ' ' : ''}-${fileChange.stats.removed}`,
                      chalk.redBright,
                    ),
                  ]
                : []),
            ]
          : [
              span(' · ', ctx.theme.subtle),
              span(fileChange.hasChanges ? fileChange.changeKind : 'no changes', ctx.theme.dimmed),
            ]),
      ),
    );

    if (!fileChange.diff) return;

    const parsedLines = parseDiffLines(fileChange.diff);
    const width = lineNumberWidth(parsedLines);
    const visibleLines = ctx.expandPreviews ? parsedLines : parsedLines.slice(0, maxLinesPerFile);

    for (const diffLine of visibleLines) {
      if (diffLine.type === 'chunk') {
        block.push(line(span('  ', ctx.theme.subtle), span(diffLine.text, chalk.cyanBright)));
        continue;
      }

      const oldLine = formatLineNumber(diffLine.oldLineNum, width);
      const newLine = formatLineNumber(diffLine.newLineNum, width);
      const prefix = diffLine.type === 'add' ? '+' : diffLine.type === 'remove' ? '-' : ' ';
      const style =
        diffLine.type === 'add'
          ? chalk.greenBright
          : diffLine.type === 'remove'
            ? chalk.redBright
            : ctx.theme.dimmed;
      const language = inferCodeLanguage(fileChange.path);
      const highlighted = highlightedCodeBlock(diffLine.text, language, ctx);
      const content =
        highlighted[0]?.type === 'styled'
          ? tintSegments(highlighted[0].segments, style)
          : [span(diffLine.text, style)];

      block.push(
        line(
          span('  ', ctx.theme.subtle),
          span(`${oldLine} ${newLine} `, ctx.theme.subtle),
          span(prefix, style),
          ...content,
        ),
      );
    }

    if (parsedLines.length > visibleLines.length) {
      block.push(
        line(
          span('  ', ctx.theme.subtle),
          span(
            `… (${parsedLines.length - visibleLines.length} more diff lines, ctrl+o to expand)`,
            ctx.theme.dimmed,
          ),
        ),
      );
    } else if (ctx.expandPreviews && parsedLines.length > maxLinesPerFile) {
      block.push(
        line(span('  ', ctx.theme.subtle), span('… (ctrl+o to collapse)', ctx.theme.dimmed)),
      );
    }
  });

  return block;
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
  const statusLabel =
    status === 'failed' ? 'failed' : status === 'running' ? `${ctx.spinnerFrame} running` : 'done';
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
