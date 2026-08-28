import {
  asObject,
  assertOnlyArguments,
  type Tool,
} from './types';

export type PlanStepStatus = 'pending' | 'in_progress' | 'completed';

export type PlanStep = {
  step: string;
  status: PlanStepStatus;
};

function parsePlanStep(value: unknown, index: number): PlanStep {
  const object = asObject(value, `update_plan plan[${index}]`);
  assertOnlyArguments(object, ['step', 'status']);
  if (typeof object.step !== 'string' || object.step.trim().length === 0)
    throw new Error(`plan[${index}].step must be a non-empty string`);
  if (!['pending', 'in_progress', 'completed'].includes(String(object.status)))
    throw new Error(`plan[${index}].status must be pending, in_progress, or completed`);
  return {
    step: object.step.trim(),
    status: object.status as PlanStepStatus,
  };
}

export function createUpdatePlanTool(): Tool {
  return {
    name: 'update_plan',
    description:
      'Updates the task plan. Provide an optional explanation and plan items with a step and status. At most one step can be in_progress at a time.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        explanation: {
          type: 'string',
          description: 'Optional explanation for this plan update.',
        },
        plan: {
          type: 'array',
          description: 'The list of steps.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              step: { type: 'string', description: 'Task step text.' },
              status: {
                type: 'string',
                enum: ['pending', 'in_progress', 'completed'],
                description: 'Step status.',
              },
            },
            required: ['step', 'status'],
          },
        },
      },
      required: ['plan'],
    },
    async execute(input: unknown) {
      const object = asObject(input, 'update_plan');
      assertOnlyArguments(object, ['explanation', 'plan']);
      if (object.explanation !== undefined && typeof object.explanation !== 'string')
        throw new Error('explanation must be a string');
      if (!Array.isArray(object.plan)) throw new Error('plan must be an array');
      const plan = object.plan.map(parsePlanStep);
      if (plan.filter(step => step.status === 'in_progress').length > 1)
        throw new Error('at most one plan step can be in_progress');
      return { output: 'Plan updated' };
    },
  };
}
