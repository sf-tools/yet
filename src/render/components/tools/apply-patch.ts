import chalk from 'chalk';

import { indent, LEFT_MARGIN } from '@/render/layout';
import { line, span } from '@/render/primitives';
import type { FileChange, ToolHistoryEntry } from '@/types';
import type { RenderContext } from '@/render/types';
import { renderFileChanges } from './shared';

function changeVerb(file: FileChange) {
  if (file.changeKind === 'created') return 'Added';
  if (file.changeKind === 'deleted') return 'Deleted';
  return 'Edited';
}

function totals(files: FileChange[]) {
  return files.reduce(
    (total, file) => ({
      added: total.added + file.stats.added + file.stats.modified,
      removed: total.removed + file.stats.removed + file.stats.modified,
    }),
    { added: 0, removed: 0 },
  );
}

export function renderApplyPatchTool(entry: ToolHistoryEntry, ctx: RenderContext) {
  const files = entry.fileChanges ?? [];
  if (entry.status === 'failed') {
    return indent(
      [
        line(span('• ', chalk.redBright), span('Edit failed', chalk.bold)),
        line(span('  └ ', ctx.theme.dimmed), span(entry.errorText || 'patch failed', chalk.redBright)),
      ],
      LEFT_MARGIN,
    );
  }

  const { added, removed } = totals(files);
  const stat = files.length > 0 ? ` (+${added} -${removed})` : '';
  const label = files.length === 1
    ? `${changeVerb(files[0])} ${files[0].path}${stat}`
    : `${entry.status === 'running' ? 'Editing' : 'Edited'} ${files.length} files${stat}`;
  const body = files.length > 0
    ? renderFileChanges(files, ctx, { showFileHeaders: files.length > 1 })
    : [];
  return indent(
    [
      line(
        span('• ', entry.status === 'running' ? ctx.theme.dimmed : chalk.greenBright),
        span(label, chalk.bold),
      ),
      ...body,
    ],
    LEFT_MARGIN,
  );
}
