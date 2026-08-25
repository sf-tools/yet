import type { ToolHistoryEntry } from '@/types';
import type { Block, RenderContext } from '@/render/types';
import { renderApplyPatchTool } from './apply-patch';
import { renderGenericTool } from './generic';
import { renderShellTool } from './shell';

const renderers: Record<string, (entry: ToolHistoryEntry, ctx: RenderContext) => Block> = {
  shell: renderShellTool,
  apply_patch: renderApplyPatchTool,
};

export function renderToolHistoryEntry(entry: ToolHistoryEntry, ctx: RenderContext) {
  return (renderers[entry.toolName] || renderGenericTool)(entry, ctx);
}
