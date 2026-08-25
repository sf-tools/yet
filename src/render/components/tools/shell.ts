import type { ToolHistoryEntry } from '@/types';
import type { RenderContext } from '@/render/types';
import { previewText, renderToolCard, stringProp } from './shared';

export function renderShellTool(entry: ToolHistoryEntry, ctx: RenderContext) {
  const cmd = stringProp(entry.input, 'command') || entry.title || 'command';
  const output = typeof entry.output === 'string' ? entry.output : '';
  const exitCode = output.match(/\n\nexit code: (-?\d+)$/)?.[1];
  const inferredFailure =
    entry.status === 'completed' && (output.startsWith('error:') || (exitCode && exitCode !== '0'));
  const status = inferredFailure ? 'failed' : entry.status;
  const body = [`$ ${cmd}`];

  if (status === 'failed') body.push(entry.errorText || output || 'command failed');
  else if (output.trim()) body.push(...previewText(output, ctx, 8));

  return renderToolCard({ name: 'shell', detail: cmd, body, status }, ctx);
}
