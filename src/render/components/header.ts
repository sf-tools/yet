import chalk from 'chalk';
import { APP_NAME, APP_VERSION } from '@/config';
import { formatSessionUsage, sessionUsageIsZero } from '@/agent/session-summary';
import { LEFT_MARGIN } from '../layout';
import { blankLine, line, span } from '../primitives';

import type { AgentUsage } from '@/agent/messages';
import type { Block, RenderContext } from '../types';

export function renderHeader(ctx: RenderContext, yoloMode = false): Block {
  return [
    blankLine(),
    line(
      span(LEFT_MARGIN),
      span(APP_NAME, ctx.theme.foreground),
      span(' '),
      span(APP_VERSION, ctx.theme.dimmed),
      ...(yoloMode ? [span(' '), span('YOLO mode', chalk.magentaBright.bold)] : []),
    ),
  ];
}

export function renderExitSummary(usage: AgentUsage, resumeCommand: string | null): Block {
  return [
    ...(!sessionUsageIsZero(usage) ? [line(span(formatSessionUsage(usage)))] : []),
    ...(resumeCommand
      ? [line(span('To continue this session, run '), span(resumeCommand, chalk.cyan))]
      : []),
  ];
}
