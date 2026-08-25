import chalk from 'chalk';

import { APP_NAME, APP_VERSION } from '@/config';
import { LEFT_MARGIN } from '../layout';
import { blankLine, line, span } from '../primitives';

import type { Block, RenderContext } from '../types';

export function renderHeader(ctx: RenderContext): Block {
  return [
    blankLine(),
    line(span(LEFT_MARGIN), span(APP_NAME, ctx.theme.foreground)),
    line(span(LEFT_MARGIN), span(APP_VERSION, ctx.theme.dimmed)),
    line(span(LEFT_MARGIN), span('hint: /permissions controls tool access', ctx.theme.subtle)),
    blankLine(),
  ];
}

export function renderExitLogo(): Block {
  return [
    line(span('      :::::::: ', chalk.cyan)),
    line(span('    :+:    :+: ', chalk.cyan)),
    line(span('   +:+         ', chalk.cyan)),
    line(span('  +#+          ', chalk.cyan)),
    line(span(' +#+           ', chalk.cyan)),
    line(span('#+#    #+#     ', chalk.cyan)),
    line(span('########       ', chalk.cyan)),
  ];
}

export function renderExitSummary(options: {
  threadTitle?: string | null;
  threadUrl?: string | null;
  resumeCommand?: string | null;
}): Block {
  const threadTitle =
    options.threadTitle?.trim() || (options.resumeCommand ? 'Untitled session' : APP_NAME);
  const threadUrl = options.resumeCommand ? options.threadUrl : APP_VERSION;

  return [
    line(span('      :::::::: ', chalk.cyan)),
    line(span('    :+:    :+: ', chalk.cyan)),
    line(span('   +:+          ', chalk.cyan), span(threadTitle, chalk.white)),
    line(span('  +#+           ', chalk.cyan), ...(threadUrl ? [span(threadUrl, chalk.blue)] : [])),
    line(
      span(' +#+            ', chalk.cyan),
      ...(options.resumeCommand ? [span(options.resumeCommand, chalk.gray)] : []),
    ),
    line(span('#+#    #+#     ', chalk.cyan)),
    line(span('########       ', chalk.cyan)),
  ];
}
