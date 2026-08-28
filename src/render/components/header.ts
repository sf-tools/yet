import { APP_NAME, APP_VERSION } from '@/config';
import { LEFT_MARGIN } from '../layout';
import { blankLine, line, span } from '../primitives';

import type { Block, RenderContext } from '../types';

export function renderHeader(ctx: RenderContext): Block {
  return [blankLine(), line(span(LEFT_MARGIN), span(APP_NAME, ctx.theme.foreground), span(' '), span(APP_VERSION, ctx.theme.dimmed))];
}

export function renderExitSummary(resumeCommand: string | null): Block {
  return resumeCommand ? [line(span(`Continue session with: ${resumeCommand}`))] : [];
}
