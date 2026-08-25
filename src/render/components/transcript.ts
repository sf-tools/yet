import chalk from 'chalk';

import { EntryKind, type ApprovalRequest, type ChoiceRequest } from '@/types';
import { LEFT_MARGIN, thinPanelize, wrapTextBlock, takeLast } from '../layout';
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

function renderChoiceNotice(
  request: ChoiceRequest,
  selectedIndex: number,
  ctx: RenderContext,
): Block {
  const width = Math.max(1, ctx.width - 4);
  const detail = wrapTextBlock(request.detail, width, ctx.theme.dimmed);
  const options = request.options.flatMap((option, index) => {
    const selected = index === selectedIndex;
    const recommended = option.value === request.recommendedValue;
    const labelStyle = selected ? ctx.theme.foreground : ctx.theme.dimmed;
    const detailStyle = selected ? ctx.theme.dimmed : ctx.theme.subtle;
    const body = option.detail
      ? wrapTextBlock(option.detail, Math.max(1, width - 6), detailStyle)
      : [];

    return [
      line(
        span(selected ? '> ' : '  ', ctx.theme.foreground),
        span(`${index + 1}. `, ctx.theme.subtle),
        span(option.label, labelStyle),
        ...(recommended
          ? [span(' · ', ctx.theme.subtle), span('recommended', ctx.theme.dimmed)]
          : []),
      ),
      ...body.map(optionLine => line(span('     '), ...optionLine.segments)),
    ];
  });

  return thinPanelize(
    [
      line(span('choice', ctx.theme.subtle)),
      line(span(request.title, ctx.theme.foreground)),
      ...detail,
      blankLine(),
      ...options,
      blankLine(),
      line(
        span('↑/↓ move', ctx.theme.dimmed),
        span(' · ', ctx.theme.subtle),
        span('enter choose', ctx.theme.dimmed),
        span(' · ', ctx.theme.subtle),
        span('1-9 quick pick', ctx.theme.dimmed),
        span(' · ', ctx.theme.subtle),
        span('esc cancel', ctx.theme.dimmed),
      ),
    ],
    { bg: ctx.theme.panelBg(), width: ctx.width },
  );
}

export function renderOutputPreview(
  reasoningText: string,
  text: string,
  ctx: RenderContext,
  pendingApproval: ApprovalRequest | null = null,
  pendingChoice: ChoiceRequest | null = null,
  pendingChoiceIndex = 0,
): Block {
  if (!reasoningText && !text && !pendingApproval && !pendingChoice) return [];

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
    : pendingChoice
      ? [...renderChoiceNotice(pendingChoice, pendingChoiceIndex, ctx), blankLine()]
      : [];

  return [...takeLast(preview, maxLines), ...notice];
}
