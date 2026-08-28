import { asObject, assertOnlyArguments, stringArgument, type Tool, type ToolFactoryOptions } from './types';

function goalOutput(goal: ReturnType<ToolFactoryOptions['getGoal']>) {
  if (!goal) return JSON.stringify({ goal: null });
  return JSON.stringify({
    objective: goal.objective,
    status: goal.status,
    token_budget: goal.tokenBudget ?? null,
    tokens_used: goal.tokensUsed,
    time_used_seconds: goal.timeUsedSeconds,
    remaining_tokens: goal.tokenBudget === undefined
      ? null
      : Math.max(0, goal.tokenBudget - goal.tokensUsed),
  });
}

export function createGoalTools(options: ToolFactoryOptions): Tool[] {
  return [
    {
      name: 'get_goal',
      description: 'Get the current goal for this thread, including status, budgets, token and elapsed-time usage, and remaining token budget.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {},
        required: [],
      },
      async execute(input: unknown) {
        const object = asObject(input, 'get_goal');
        assertOnlyArguments(object, []);
        return { output: goalOutput(options.getGoal()) };
      },
    },
    {
      name: 'create_goal',
      description: 'Create a goal only when explicitly requested by the user or system/developer instructions; do not infer goals from ordinary tasks. Set token_budget only when an explicit token budget is requested. Fails if an unfinished goal exists; use update_goal only for status.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          objective: {
            type: 'string',
            description: 'Required. The concrete objective to start pursuing. This starts a new active goal when no goal exists or replaces the current goal when it is complete.',
          },
          token_budget: {
            type: 'integer',
            minimum: 1,
            description: 'Positive token budget for the new goal. Omit unless explicitly requested.',
          },
        },
        required: ['objective'],
      },
      async execute(input: unknown) {
        const object = asObject(input, 'create_goal');
        assertOnlyArguments(object, ['objective', 'token_budget']);
        const objective = stringArgument(object, 'objective').trim();
        const tokenBudget = object.token_budget;
        if (tokenBudget !== undefined && (!Number.isSafeInteger(tokenBudget) || Number(tokenBudget) <= 0))
          throw new Error('token_budget must be a positive integer');
        return { output: goalOutput(options.createGoal(objective, tokenBudget as number | undefined)) };
      },
    },
    {
      name: 'update_goal',
      description: 'Update the existing goal. Use this tool only to mark the goal achieved or genuinely blocked. Set status to complete only when the objective is achieved and no required work remains. Set status to blocked only after the same blocking condition has repeated for at least three consecutive goal turns and the agent cannot make meaningful progress without user input or an external-state change. Do not use blocked merely because the work is hard, slow, uncertain, incomplete, or would benefit from clarification. Do not mark a goal complete merely because its budget is nearly exhausted or because you are stopping work.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: {
            type: 'string',
            enum: ['complete', 'blocked'],
            description: 'Required terminal status.',
          },
        },
        required: ['status'],
      },
      async execute(input: unknown) {
        const object = asObject(input, 'update_goal');
        assertOnlyArguments(object, ['status']);
        if (object.status !== 'complete' && object.status !== 'blocked')
          throw new Error('status must be complete or blocked');
        return { output: goalOutput(options.updateGoal(object.status)) };
      },
    },
  ];
}
