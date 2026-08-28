import type { ToolHistoryEntry } from '@/types';
import type { Block, RenderContext } from '@/render/types';
import { renderApplyPatchTool } from './apply-patch';
import { renderGenericTool } from './generic';
import { renderCommandActivity } from './command-activity';
import { renderUpdatePlanTool } from './update-plan';

const renderers: Record<string, (entry: ToolHistoryEntry, ctx: RenderContext) => Block> = {
  exec_command: (entry, ctx) => renderCommandActivity([entry], ctx),
  write_stdin: (entry, ctx) => renderCommandActivity([entry], ctx),
  apply_patch: renderApplyPatchTool,
  update_plan: renderUpdatePlanTool,
};

export function renderToolHistoryEntry(entry: ToolHistoryEntry, ctx: RenderContext) {
  return (renderers[entry.toolName] || renderGenericTool)(entry, ctx);
}
