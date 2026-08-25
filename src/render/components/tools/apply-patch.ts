import type { ToolHistoryEntry } from '@/types';
import type { RenderContext } from '@/render/types';
import { renderFileChanges, renderToolCard } from './shared';

export function renderApplyPatchTool(entry: ToolHistoryEntry, ctx: RenderContext) {
  const count = entry.fileChanges?.length ?? 0;
  const detail = count ? `${count} file${count === 1 ? '' : 's'}` : 'unified diff';
  const body = entry.status === 'failed' ? [entry.errorText || 'patch failed'] : [];
  const bodyBlock = entry.fileChanges?.length ? renderFileChanges(entry.fileChanges, ctx) : [];
  return renderToolCard({ name: 'apply patch', detail, body, bodyBlock, status: entry.status }, ctx);
}
