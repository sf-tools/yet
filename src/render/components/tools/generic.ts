import type { ToolHistoryEntry } from '@/types';
import type { RenderContext } from '@/render/types';
import { previewJson, renderToolCard } from './shared';

export function renderGenericTool(entry: ToolHistoryEntry, ctx: RenderContext) {
  const body =
    entry.status === 'failed'
      ? [entry.errorText || 'tool failed', 'input:', ...previewJson(entry.input, ctx)]
      : entry.status === 'running'
        ? ['input:', ...previewJson(entry.input, ctx)]
        : [
            'input:',
            ...previewJson(entry.input, ctx),
            'output:',
            ...previewJson(entry.output, ctx),
          ];

  return renderToolCard(
    { name: entry.toolName.replace(/_/g, ' '), body, status: entry.status },
    ctx,
  );
}
