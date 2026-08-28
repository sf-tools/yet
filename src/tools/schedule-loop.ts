import {
  asObject,
  assertOnlyArguments,
  type ScheduleLoopWakeupRequest,
  type ScheduleLoopWakeupResult,
  type Tool,
} from './types';

type ScheduleLoopToolOptions = {
  schedule(request: ScheduleLoopWakeupRequest): ScheduleLoopWakeupResult;
};

function parseScheduleRequest(input: unknown): ScheduleLoopWakeupRequest {
  const object = asObject(input, 'schedule_loop');
  assertOnlyArguments(object, ['delay_seconds', 'reason', 'stop']);

  if (object.stop !== undefined && typeof object.stop !== 'boolean')
    throw new Error('stop must be a boolean');
  if (object.stop === true) return { stop: true };

  if (
    typeof object.delay_seconds !== 'number' ||
    !Number.isFinite(object.delay_seconds) ||
    !Number.isInteger(object.delay_seconds) ||
    object.delay_seconds <= 0
  ) throw new Error('delay_seconds must be a positive whole number');
  if (typeof object.reason !== 'string' || !object.reason.trim())
    throw new Error('reason must be a non-empty string');

  return {
    delaySeconds: object.delay_seconds,
    reason: object.reason.trim(),
  };
}

export function createScheduleLoopTool(options: ScheduleLoopToolOptions): Tool {
  return {
    name: 'schedule_loop',
    description:
      'Schedules the next iteration of the active self-paced /loop. Choose a delay that matches the task, or set stop to true when no more iterations are useful.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        delay_seconds: {
          type: 'integer',
          minimum: 1,
          description: 'Seconds to wait before the next iteration. The runtime clamps this to 60–3600 seconds.',
        },
        reason: {
          type: 'string',
          description: 'One short sentence that explains why this delay fits the task.',
        },
        stop: {
          type: 'boolean',
          description: 'Set to true to end the loop without scheduling another iteration.',
        },
      },
    },
    async execute(input: unknown) {
      const result = options.schedule(parseScheduleRequest(input));
      if (result.stopped) return { output: 'Loop stopped; no further iterations are scheduled.' };
      if (result.scheduledFor === null || result.delaySeconds === null)
        throw new Error('loop wakeup was not scheduled');

      return {
        output: JSON.stringify({
          scheduled_for: new Date(result.scheduledFor).toISOString(),
          delay_seconds: result.delaySeconds,
        }),
      };
    },
  };
}
