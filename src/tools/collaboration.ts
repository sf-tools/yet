import type { AgentControl } from '@/agent/collaboration/control';
import {
  asObject,
  assertOnlyArguments,
  stringArgument,
  type JsonSchema,
  type Tool,
} from './types';

const namespace = 'collaboration';
const namespaceDescription = 'Tools for spawning and managing sub-agents.';

const objectSchema = (
  properties: Record<string, JsonSchema>,
  required: string[] = [],
): JsonSchema => ({
  type: 'object',
  properties,
  ...(required.length > 0 ? { required } : {}),
  additionalProperties: false,
});

const stringSchema = (description: string): JsonSchema => ({ type: 'string', description });
const encryptedStringSchema = (description: string): JsonSchema => ({
  type: 'string',
  description,
  encrypted: true,
});
const numberSchema = (description: string): JsonSchema => ({ type: 'number', description });

const agentStatusSchema: JsonSchema = {
  oneOf: [
    { type: 'string', enum: ['pending_init', 'running', 'interrupted', 'shutdown', 'not_found'] },
    {
      type: 'object',
      properties: { completed: { type: ['string', 'null'] } },
      required: ['completed'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: { errored: { type: 'string' } },
      required: ['errored'],
      additionalProperties: false,
    },
  ],
};

const modelDescriptions = [
  '- `gpt-5.6-sol`: Latest frontier agentic coding model. Reasoning efforts: low (default), medium, high, xhigh, max, ultra. Service tiers: priority.',
  '- `gpt-5.6-terra`: Balanced agentic coding model for everyday work. Reasoning efforts: low, medium (default), high, xhigh, max, ultra. Service tiers: priority.',
  '- `gpt-5.6-luna`: Fast and affordable agentic coding model. Reasoning efforts: low, medium (default), high, xhigh, max. Service tiers: priority.',
  '- `gpt-daybreak-blue-latest`: Latest frontier agentic coding model for broad defensive cybersecurity work. Reasoning efforts: low (default), medium, high, xhigh, max, ultra.',
  '- `gpt-5.5`: Frontier model for complex coding, research, and real-world work. Reasoning efforts: low, medium (default), high, xhigh. Service tiers: priority.',
].join('\n');

export const SPAWN_AGENT_DESCRIPTION = `Available model overrides (optional; inherited parent model is preferred):
${modelDescriptions}
Spawns an agent to work on the specified task. If your current task is \`/root/task1\` and you spawn_agent with task_name "task_3" the agent will have canonical task name \`/root/task1/task_3\`.
You are then able to refer to this agent as \`task_3\` or \`/root/task1/task_3\` interchangeably. However an agent \`/root/task2/task_3\` would only be able to communicate with this agent via its canonical name \`/root/task1/task_3\`.
The spawned agent will have the same tools as you and the ability to spawn its own subagents.

Only call this tool for a concrete, bounded subtask that can run independently alongside useful local work; otherwise continue locally.
It will be able to send you and other running agents messages, and its final answer will be provided to you when it finishes.
The new agent's canonical task name will be provided to it along with the message.

Note that passing \`fork_turns="none"\` will not pass any surrounding context to the spawned subagent, which may cause the agent to lack the context it needs to complete its task, whereas \`fork_turns="all"\` will provide the subagent with all surrounding context.`;

export const COLLABORATION_TOOL_CONTRACT = [
  {
    name: 'spawn_agent',
    description: SPAWN_AGENT_DESCRIPTION,
    inputSchema: objectSchema({
      fork_turns: stringSchema('Optional number of turns to fork. Defaults to `all`. Use `none`, `all`, or a positive integer string such as `3` to fork only the most recent turns.'),
      message: encryptedStringSchema('Initial plain-text task for the new agent.'),
      model: stringSchema('Model override for the new agent. Omit unless an explicit override is needed.'),
      reasoning_effort: stringSchema('Reasoning effort override for the new agent. Omit to inherit the parent effort.'),
      task_name: stringSchema('Task name for the new agent. Use lowercase letters, digits, and underscores.'),
    }, ['task_name', 'message']),
    outputSchema: objectSchema({
      task_name: stringSchema('Canonical task name for the spawned agent.'),
    }, ['task_name']),
  },
  {
    name: 'send_message',
    description: 'Send a message to an existing agent. The message will be delivered promptly. Does not trigger a new turn.',
    inputSchema: objectSchema({
      message: encryptedStringSchema('Message text to queue on the target agent.'),
      target: stringSchema('Relative or canonical task name to message (from spawn_agent).'),
    }, ['target', 'message']),
  },
  {
    name: 'followup_task',
    description: 'Send a follow-up task to an existing non-root target agent and trigger a turn if it is idle. If the target is already running, deliver the task promptly at message boundaries while sampling, or after the pending tool call completes.',
    inputSchema: objectSchema({
      message: encryptedStringSchema('Message text to send to the target agent.'),
      target: stringSchema('Agent id or canonical task name to send a follow-up task to (from spawn_agent).'),
    }, ['target', 'message']),
  },
  {
    name: 'wait_agent',
    description: "Wait for a mailbox update from any live agent, including queued messages and final-status notifications. The wait also ends early when new user input is steered into the active turn. Does not return the content; returns either a summary of which agents have updates (if any), an interruption summary for steered input, or a timeout summary if no activity arrives before the deadline.",
    inputSchema: objectSchema({
      timeout_ms: numberSchema('Timeout in milliseconds. Defaults to 30000, min 10000, max 3600000.'),
    }),
    outputSchema: objectSchema({
      message: stringSchema("Brief wait summary without the agent's final content, including any timeout adjustment."),
      timed_out: { type: 'boolean', description: 'Whether the wait call returned because no mailbox update arrived before the timeout.' },
    }, ['message', 'timed_out']),
  },
  {
    name: 'list_agents',
    description: 'List live agents in the current root thread tree. Optionally filter by task-path prefix.',
    inputSchema: objectSchema({
      path_prefix: stringSchema('Task-path prefix filter without a trailing slash. Omit to list all live agents.'),
    }),
    outputSchema: objectSchema({
      agents: {
        type: 'array',
        description: 'Live agents visible in the current root thread tree.',
        items: objectSchema({
          agent_name: stringSchema('Canonical task name for the agent when available, otherwise the agent id.'),
          agent_status: { description: 'Last known status of the agent.', allOf: [agentStatusSchema] },
        }, ['agent_name', 'agent_status']),
      },
    }, ['agents']),
  },
  {
    name: 'interrupt_agent',
    description: "Interrupt an agent's current turn, if any, and return its previous status. The agent remains available for messages and follow-up tasks.",
    inputSchema: objectSchema({
      target: stringSchema('Agent id or canonical task name to interrupt (from spawn_agent).'),
    }, ['target']),
    outputSchema: objectSchema({
      previous_status: {
        description: 'The agent status observed before the interrupt request was handled.',
        allOf: [agentStatusSchema],
      },
    }, ['previous_status']),
  },
] as const;

export function createCollaborationTools(options: {
  agentId: string;
  agentPath: string;
  control: AgentControl;
}): Tool[] {
  return COLLABORATION_TOOL_CONTRACT.map(spec => ({
    ...spec,
    namespace,
    namespaceDescription,
    async execute(input: unknown) {
      const object = asObject(input, spec.name);
      switch (spec.name) {
        case 'spawn_agent': {
          assertOnlyArguments(object, ['fork_turns', 'message', 'model', 'reasoning_effort', 'task_name']);
          const result = await options.control.spawnAgent(options.agentId, {
            taskName: stringArgument(object, 'task_name'),
            message: stringArgument(object, 'message'),
            forkTurns: object.fork_turns,
            ...(typeof object.model === 'string' ? { model: object.model } : {}),
            ...(typeof object.reasoning_effort === 'string' ? { reasoningEffort: object.reasoning_effort } : {}),
          });
          return { output: JSON.stringify({ task_name: result.task_name }) };
        }
        case 'send_message':
        case 'followup_task': {
          assertOnlyArguments(object, ['target', 'message']);
          await options.control.sendMessage(
            options.agentId,
            stringArgument(object, 'target'),
            stringArgument(object, 'message'),
            { triggerTurn: spec.name === 'followup_task' },
          );
          return { output: '' };
        }
        case 'wait_agent': {
          assertOnlyArguments(object, ['timeout_ms']);
          const timeoutMs = object.timeout_ms;
          if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs))) {
            throw new Error('timeout_ms must be a finite number');
          }
          return { output: JSON.stringify(await options.control.waitAgent(options.agentId, timeoutMs as number | undefined)) };
        }
        case 'list_agents': {
          assertOnlyArguments(object, ['path_prefix']);
          const pathPrefix = object.path_prefix;
          if (pathPrefix !== undefined && typeof pathPrefix !== 'string') throw new Error('path_prefix must be a string');
          return { output: JSON.stringify({ agents: options.control.listAgents(options.agentId, pathPrefix) }) };
        }
        case 'interrupt_agent': {
          assertOnlyArguments(object, ['target']);
          return {
            output: JSON.stringify(await options.control.interruptAgent(
              options.agentId,
              stringArgument(object, 'target'),
            )),
          };
        }
      }
    },
  }));
}
