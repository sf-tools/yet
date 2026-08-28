import chalk from 'chalk';

import { indent, LEFT_MARGIN } from '@/render/layout';
import { line, span } from '@/render/primitives';
import { renderDiffSummaryHeader } from '@/render/diff';
import type { ToolHistoryEntry } from '@/types';
import type { RenderContext } from '@/render/types';
import { renderFileChanges } from './shared';

export function renderApplyPatchTool(entry: ToolHistoryEntry, ctx: RenderContext) {
  const files = entry.fileChanges ?? [];
  if (entry.status === 'failed') {
    return indent(
      [
        line(span('✘ Failed to apply patch', value => chalk.magenta(chalk.bold(value)))),
        ...(entry.errorText
          ? [line(span('  └ ', ctx.theme.dimmed), span(entry.errorText, ctx.theme.dimmed))]
          : []),
      ],
      LEFT_MARGIN,
    );
  }

  if (files.length === 0) {
    return indent(
      [line(span('• ', ctx.theme.dimmed), span('Editing files', chalk.bold))],
      LEFT_MARGIN,
    );
  }

  const body = files.length > 0
    ? renderFileChanges(files, ctx, { showFileHeaders: files.length > 1 })
    : [];
  return indent(
    [
      renderDiffSummaryHeader(files, ctx),
      ...body,
    ],
    LEFT_MARGIN,
  );
}
