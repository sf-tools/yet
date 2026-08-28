import chalk from 'chalk';

import { widthOf } from '@/text';
import { EntryKind, type ApprovalRequest, type ChoiceRequest } from '@/types';
import { LEFT_MARGIN, panelize, thinPanelize, wrapTextBlock, takeLast } from '../layout';
import { blankLine, line, span } from '../primitives';
import { renderHistoryEntry } from './entry';
import { renderFileChanges } from './tools/shared';

import type { Block, RenderContext } from '../types';

function clipPreviewText(text: string, ctx: RenderContext, maxLines: number) {
  const maxChars = Math.max(2_000, ctx.width * maxLines * 8);
  if (text.length <= maxChars) return text;
  return `…${text.slice(-maxChars)}`;
}

function renderApprovalNotice(request: ApprovalRequest, ctx: RenderContext): Block {
  const width = Math.max(1, ctx.width - 4);
  const detail = wrapTextBlock(request.detail, width, ctx.theme.dimmed);
  const body = (request.body ?? []).flatMap(text => wrapTextBlock(text, width, ctx.theme.subtle));
  const fileChanges = request.fileChanges?.length
    ? renderFileChanges(request.fileChanges, ctx, {
        maxLinesPerFile: Math.max(10, ctx.height - 20),
      })
    : [];

  return thinPanelize(
    [
      line(span('Approval required', chalk.yellow)),
      line(span(request.title, ctx.theme.foreground)),
      ...detail,
      ...(body.length > 0 ? [blankLine(), ...body] : []),
      ...(fileChanges.length > 0 ? [blankLine(), ...fileChanges] : []),
      blankLine(),
      line(
        span('[y] once', chalk.yellow),
        span(' · ', ctx.theme.subtle),
        span('[n] deny', chalk.redBright),
      ),
    ],
    { bg: ctx.theme.panelBg(), width: ctx.width },
  );
}

export function renderChoicePrompt(
  request: ChoiceRequest,
  selectedIndex: number,
  ctx: RenderContext,
): Block {
  const width = Math.max(1, ctx.width - 4);
  const detail = wrapTextBlock(request.detail, width, ctx.theme.dimmed);
  const labelWidth = request.options.reduce(
    (max, option) => Math.max(max, widthOf(option.label)),
    0,
  );
  const options = request.options.map((option, index) => {
    const selected = index === selectedIndex;
    const selectedStyle = selected ? chalk.cyanBright : ctx.theme.foreground;
    const detailStyle = selected ? chalk.cyanBright : ctx.theme.dimmed;
    const prefix = `${index + 1}. `;
    const label = `${option.label}${' '.repeat(Math.max(0, labelWidth - widthOf(option.label)))}`;

    return {
      selected,
      row: line(
        span(selected ? '› ' : '  ', selected ? chalk.cyanBright : ctx.theme.foreground),
        span(prefix, selectedStyle),
        span(label, selectedStyle),
        ...(option.detail ? [span('  '), span(option.detail, detailStyle)] : []),
      ),
    };
  });
  const panelBackground = ctx.theme.composerBg();

  return [
    ...panelize(
      [
        blankLine(),
        line(span(request.title, chalk.bold)),
        ...detail,
        blankLine(),
      ],
      { bg: panelBackground, width: ctx.width },
    ),
    ...options.flatMap(option => {
      // Keep the selected chevron's painted cell inside the panel's right edge.
      const rowWidth = option.selected ? ctx.width + 1 : ctx.width;
      return panelize([option.row], {
        bg: panelBackground,
        width: rowWidth,
      });
    }),
    ...panelize([blankLine()], { bg: panelBackground, width: ctx.width }),
    line(
      span(`${LEFT_MARGIN} `),
      span('Press enter to confirm or esc to go back', ctx.theme.dimmed),
    ),
  ];
}

export function renderOutputPreview(
  reasoningText: string,
  text: string,
  ctx: RenderContext,
  pendingApproval: ApprovalRequest | null = null,
): Block {
  if (!reasoningText && !text && !pendingApproval) return [];

  const maxLines = Math.max(3, ctx.height - 12);
  const previewBlocks: Block[] = [];

  if (reasoningText) {
    const clippedReasoning = clipPreviewText(reasoningText, ctx, maxLines);
    previewBlocks.push(
      renderHistoryEntry({ type: 'entry', kind: EntryKind.Reasoning, text: clippedReasoning }, ctx),
    );
  }

  if (text) {
    const previewText = clipPreviewText(text, ctx, maxLines);
    previewBlocks.push(
      renderHistoryEntry({ type: 'entry', kind: EntryKind.Assistant, text: previewText }, ctx),
    );
  }

  const preview = previewBlocks.flatMap((block, index) =>
    index === 0 ? block : [blankLine(), ...block],
  );
  const notice = pendingApproval
    ? [...renderApprovalNotice(pendingApproval, ctx), blankLine()]
    : [];

  return [...takeLast(preview, maxLines), ...notice];
}
