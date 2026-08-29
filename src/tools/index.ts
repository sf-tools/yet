import { createApplyPatchTool } from './apply-patch';
import { createExecCommandTool } from './exec-command';
import { createWriteStdinTool } from './write-stdin';
import { createUpdatePlanTool } from './update-plan';
import { createGoalTools } from './goals';
import { createScheduleLoopTool } from './schedule-loop';
import { createCollaborationTools } from './collaboration';
import type { Tool, ToolFactoryOptions } from './types';

export type ToolRegistry = ReturnType<typeof createToolRegistry>;
export type {
  JsonSchema,
  ScheduleLoopWakeupRequest,
  ScheduleLoopWakeupResult,
  Tool,
  ToolExecutionResult,
  ToolFactoryOptions,
  ToolAuthorization,
} from './types';
export { createScheduleLoopTool } from './schedule-loop';

export function createToolRegistry(options: ToolFactoryOptions) {
  const entries = [
    createExecCommandTool(options),
    createWriteStdinTool(options),
    createUpdatePlanTool(),
    createApplyPatchTool(options),
    ...createGoalTools(options),
    ...(options.scheduleLoopWakeup
      ? [createScheduleLoopTool({ schedule: options.scheduleLoopWakeup })]
      : []),
    ...(options.collaboration ? createCollaborationTools(options.collaboration) : []),
  ] as Tool[];
  const key = (name: string, namespace?: string) => namespace ? `${namespace}:${name}` : name;
  const tools = new Map(entries.map(tool => [key(tool.name, tool.namespace), tool]));

  return {
    list() {
      return [...tools.values()].filter(
        tool =>
          (!options.getPlanningMode() || tool.name !== 'apply_patch') &&
          (tool.name !== 'schedule_loop' || options.getLoopPacingActive?.() === true),
      );
    },
    get(name: string, namespace?: string) {
      return tools.get(key(name, namespace)) ?? tools.get(name) ?? null;
    },
    async execute(name: string, input: unknown, namespace?: string) {
      const tool = tools.get(key(name, namespace)) ?? tools.get(name);
      if (!tool) throw new Error(`unknown tool: ${name}`);
      return await tool.execute(input);
    },
  };
}
