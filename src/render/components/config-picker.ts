import chalk from 'chalk';

import { widthOf } from '@/text';
import { LEFT_MARGIN, panelize, wrapTextBlock } from '../layout';
import { blankLine, line, span } from '../primitives';

import type { ConfigPickerState } from '@/types';
import type { Block, RenderContext } from '../types';

export function renderConfigPicker(
  picker: ConfigPickerState,
  ctx: RenderContext,
): Block {
  const panelBackground = ctx.theme.composerBg();
  const contentWidth = Math.max(1, ctx.width - 5);
  const labelWidth = picker.items.reduce(
    (width, item) => Math.max(width, widthOf(item.label)),
    0,
  );
  const descriptionWidth = Math.max(1, contentWidth - 6 - labelWidth - 2);

  const rows = picker.items.flatMap((item, index) => {
    const selected = index === picker.selectedIndex;
    const rowStyle = selected ? chalk.cyanBright : ctx.theme.foreground;
    const detailStyle = selected ? chalk.cyanBright : ctx.theme.dimmed;
    const marker = item.enabled ? 'x' : ' ';
    const prefix = `${selected ? '›' : ' '} [${marker}] `;
    const paddedLabel = `${item.label}${' '.repeat(Math.max(0, labelWidth - widthOf(item.label)))}`;
    const detailLines = wrapTextBlock(item.detail, descriptionWidth, detailStyle);
    const [firstDetail, ...remainingDetails] = detailLines;
    const continuation = ' '.repeat(6 + labelWidth + 2);

    return [
      line(
        span(prefix, rowStyle),
        span(paddedLabel, rowStyle),
        span('  '),
        ...(firstDetail?.segments ?? []),
      ),
      ...remainingDetails.map(detail => line(span(continuation), ...detail.segments)),
    ];
  });

  return [
    ...panelize(
      [
        blankLine(),
        line(span(picker.title, chalk.bold)),
        ...wrapTextBlock(picker.detail, contentWidth, ctx.theme.dimmed),
        blankLine(),
        ...rows,
        blankLine(),
      ],
      { bg: panelBackground, width: ctx.width },
    ),
    line(
      span(`${LEFT_MARGIN} `),
      span('Press space to select or enter to save', ctx.theme.dimmed),
    ),
  ];
}
