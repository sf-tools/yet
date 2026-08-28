import { createApplyPatchTool } from './apply-patch';
import { createExecCommandTool } from './exec-command';
import { createWriteStdinTool } from './write-stdin';
import { createUpdatePlanTool } from './update-plan';
import { createGoalTools } from './goals';
import { createScheduleLoopTool } from './schedule-loop';
import type { Tool, ToolFactoryOptions } from './types';

export type ToolRegistry = ReturnType<typeof createToolRegistry>;
export type {
  JsonSchema,
  ScheduleLoopWakeupRequest,
  ScheduleLoopWakeupResult,
  Tool,
  ToolExecutionResult,
  ToolFactoryOptions,
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
  ] as Tool[];
  const tools = new Map(entries.map(tool => [tool.name, tool]));

  return {
    list() {
      return [...tools.values()].filter(
        tool =>
          (!options.getPlanningMode() || tool.name !== 'apply_patch') &&
          (tool.name !== 'schedule_loop' || options.getLoopPacingActive?.() === true),
      );
    },
    get(name: string) {
      return tools.get(name) ?? null;
    },
    async execute(name: string, input: unknown) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`unknown tool: ${name}`);
      return await tool.execute(input);
    },
  };
}
