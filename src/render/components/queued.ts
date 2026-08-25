import { panelize } from '../layout';
import { line, span } from '../primitives';
import { widthOf } from '@/text';

import type { Block, RenderContext } from '../types';
import type { QueuedSubmission } from '@/store';

function truncate(text: string, width: number) {
  if (width <= 0) return '';
  if (widthOf(text) <= width) return text;

  let out = '';
  for (const ch of Array.from(text)) {
    if (widthOf(out + ch + '…') > width) break;
    out += ch;
  }

  return `${out}…`;
}

export function renderQueuedSubmissions(
  queuedSubmissions: QueuedSubmission[],
  ctx: RenderContext,
  maxLines = Number.POSITIVE_INFINITY,
): Block {
  if (queuedSubmissions.length === 0 || maxLines <= 0) return [];

  const limit = Math.max(1, Math.floor(maxLines));
  const block: Block = [];
  const previewLimit = Math.min(2, limit, queuedSubmissions.length);

  for (let index = 0; index < previewLimit; index += 1) {
    const text = truncate(
      queuedSubmissions[index]?.text.trim() || '(empty message)',
      Math.max(1, ctx.width - 6),
    );
    block.push(line(span(`${index + 1}. `, ctx.theme.subtle), span(text, ctx.theme.dimmed)));
  }

  if (queuedSubmissions.length > previewLimit && block.length < limit) {
    block.push(line(span('more queued messages', ctx.theme.subtle)));
  }

  return panelize(block, { bg: ctx.theme.panelBg(), width: ctx.width });
}
