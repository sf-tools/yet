import chalk from 'chalk';

import { LEFT_MARGIN, panelize, wrapTextBlock } from '../layout';
import { blankLine, line, span } from '../primitives';
import type { TextPromptRequest } from '@/types';
import type { Block, RenderContext } from '../types';

export function renderTextPrompt(
  request: TextPromptRequest,
  composer: Block,
  ctx: RenderContext,
): Block {
  return [
    ...panelize(
      [
        blankLine(),
        line(span(request.title, chalk.bold)),
        ...wrapTextBlock(request.detail, Math.max(1, ctx.width - 5), ctx.theme.dimmed),
        blankLine(),
      ],
      { bg: ctx.theme.composerBg(), width: ctx.width },
    ),
    ...composer,
    line(span(`${LEFT_MARGIN} `), span('Press enter to confirm or esc to go back', ctx.theme.dimmed)),
  ];
}
