import chalk from 'chalk';

import { widthOf } from '@/text';
import { panelize, wrapTextBlock } from '../layout';
import { blankLine, line, span } from '../primitives';

import type { StatusPanelState } from '@/types';
import type { Block, RenderContext } from '../types';

export function renderStatusPanel(panel: StatusPanelState, ctx: RenderContext): Block {
  const contentWidth = Math.max(1, ctx.width - 5);
  const labelWidth = Math.min(
    14,
    panel.sections.flatMap(section => section.rows).reduce(
      (width, row) => Math.max(width, widthOf(row.label)),
      0,
    ),
  );
  const valueWidth = Math.max(1, contentWidth - labelWidth - 2);
  const rows = panel.sections.flatMap((section, sectionIndex) => [
    ...(sectionIndex > 0 ? [blankLine()] : []),
    line(span(section.title, chalk.cyanBright.bold)),
    ...section.rows.flatMap(row => {
      const values = wrapTextBlock(row.value, valueWidth, ctx.theme.foreground);
      const [first, ...rest] = values;
      const continuation = ' '.repeat(labelWidth + 2);
      return [
        line(span(row.label.padEnd(labelWidth), ctx.theme.dimmed), span('  '), ...(first?.segments ?? [])),
        ...rest.map(value => line(span(continuation), ...value.segments)),
      ];
    }),
  ]);

  return [
    ...panelize(
      [blankLine(), line(span(panel.title, chalk.bold)), blankLine(), ...rows, blankLine()],
      { bg: ctx.theme.composerBg(), width: ctx.width },
    ),
    line(span('  Press enter or esc to close', ctx.theme.dimmed)),
  ];
}
