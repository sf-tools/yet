import chalk from 'chalk';

import { indent, LEFT_MARGIN, wrapTextBlock } from '@/render/layout';
import { line, span } from '@/render/primitives';
import type { Block, RenderContext } from '@/render/types';
import type { ToolHistoryEntry } from '@/types';
import { asRecord } from './shared';

type PlanStatus = 'pending' | 'in_progress' | 'completed';

function parsePlan(entry: ToolHistoryEntry) {
  const input = asRecord(entry.input);
  const explanation = typeof input?.explanation === 'string' ? input.explanation.trim() : '';
  const plan = Array.isArray(input?.plan)
    ? input.plan.flatMap(value => {
        const item = asRecord(value);
        if (!item || typeof item.step !== 'string') return [];
        const status = item.status;
        if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') return [];
        return [{ step: item.step, status } as { step: string; status: PlanStatus }];
      })
    : [];
  return { explanation, plan };
}

function stepStyle(status: PlanStatus) {
  if (status === 'completed') return chalk.dim.strikethrough;
  if (status === 'in_progress') return chalk.cyanBright.bold;
  return chalk.dim;
}

export function renderUpdatePlanTool(entry: ToolHistoryEntry, ctx: RenderContext): Block {
  if (entry.status === 'failed') {
    return indent(
      [
        line(span('• ', chalk.redBright), span('Update plan failed', chalk.bold)),
        line(span('  └ ', ctx.theme.dimmed), span(entry.errorText || 'unknown error', chalk.redBright)),
      ],
      LEFT_MARGIN,
    );
  }

  const { explanation, plan } = parsePlan(entry);
  const body: Block = [];
  if (explanation) {
    const wrapped = wrapTextBlock(explanation, Math.max(1, ctx.width - 5), chalk.dim.italic);
    wrapped.forEach((part, index) =>
      body.push(line(span(index === 0 ? '  └ ' : '    ', chalk.dim), ...part.segments)),
    );
  }
  const prefix = explanation ? '    ' : '  └ ';
  if (plan.length === 0) {
    body.push(line(span(prefix, chalk.dim), span('(no steps provided)', chalk.dim.italic)));
  } else {
    plan.forEach((item, itemIndex) => {
      const wrapped = wrapTextBlock(
        item.step,
        Math.max(1, ctx.width - 7),
        stepStyle(item.status),
      );
      wrapped.forEach((part, lineIndex) =>
        body.push(
          line(
            span(itemIndex === 0 && lineIndex === 0 ? prefix : '    ', chalk.dim),
            span(lineIndex === 0 ? `${item.status === 'completed' ? '✔' : '□'} ` : '  ', stepStyle(item.status)),
            ...part.segments,
          ),
        ),
      );
    });
  }

  return indent(
    [line(span('• ', chalk.dim), span(entry.status === 'running' ? 'Updating Plan' : 'Updated Plan', chalk.bold)), ...body],
    LEFT_MARGIN,
  );
}
