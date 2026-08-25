import { createApplyPatchTool } from './apply-patch';
import { createShellTool } from './shell';
import type { Tool, ToolFactoryOptions } from './types';

export type ToolRegistry = ReturnType<typeof createToolRegistry>;
export type { JsonSchema, Tool, ToolExecutionResult, ToolFactoryOptions } from './types';

export function createToolRegistry(options: ToolFactoryOptions) {
  const entries = [createShellTool(options), createApplyPatchTool(options)] as Tool[];
  const tools = new Map(entries.map(tool => [tool.name, tool]));

  return {
    list() {
      return [...tools.values()].filter(
        tool => !options.getPlanningMode() || tool.name === 'shell',
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
