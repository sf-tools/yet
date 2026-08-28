import { asObject, assertOnlyArguments, type ToolFactoryOptions } from './types';

export function createWriteStdinTool(options: ToolFactoryOptions) {
  return {
    name: 'write_stdin',
    description: 'Writes characters to an existing background terminal and returns recent output.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        session_id: {
          type: 'integer',
          minimum: 1,
          description: 'Identifier of the running terminal session.',
        },
        chars: {
          type: 'string',
          description: 'Bytes to write to stdin. Defaults to empty, which polls without writing.',
        },
        yield_time_ms: {
          type: 'integer',
          minimum: 250,
          maximum: 300000,
          description: 'Wait before yielding more output.',
        },
        max_output_tokens: {
          type: 'integer',
          minimum: 250,
          maximum: 50000,
          description: 'Output token budget. Defaults to 10000 tokens.',
        },
      },
      required: ['session_id'],
    },
    async execute(input: unknown) {
      const object = asObject(input, 'write_stdin');
      assertOnlyArguments(object, ['session_id', 'chars', 'yield_time_ms', 'max_output_tokens']);
      const sessionId = object.session_id;
      if (typeof sessionId !== 'number' || !Number.isInteger(sessionId) || sessionId < 1)
        throw new Error('session_id must be a positive integer');
      if (object.chars !== undefined && typeof object.chars !== 'string')
        throw new Error('chars must be a string');
      const yieldTimeMs = object.yield_time_ms;
      if (
        yieldTimeMs !== undefined &&
        (typeof yieldTimeMs !== 'number' ||
          !Number.isInteger(yieldTimeMs) ||
          yieldTimeMs < 250 ||
          yieldTimeMs > 300_000)
      ) {
        throw new Error('yield_time_ms must be an integer between 250 and 300000');
      }
      const maxOutputTokens = object.max_output_tokens;
      if (
        maxOutputTokens !== undefined &&
        (typeof maxOutputTokens !== 'number' ||
          !Number.isInteger(maxOutputTokens) ||
          maxOutputTokens < 250 ||
          maxOutputTokens > 50_000)
      ) {
        throw new Error('max_output_tokens must be an integer between 250 and 50000');
      }

      const result = await options.writeStdin(sessionId, object.chars ?? '', {
        yieldTimeMs,
        maxOutputTokens,
      });
      return {
        output: JSON.stringify({
          output: result.output,
          wall_time_seconds: result.wallTimeSeconds,
          ...(result.exitCode === undefined ? {} : { exit_code: result.exitCode }),
          ...(result.sessionId === undefined ? {} : { session_id: result.sessionId }),
          ...(result.originalTokenCount === undefined
            ? {}
            : { original_token_count: result.originalTokenCount }),
        }),
      };
    },
  } satisfies import('./types').Tool;
}
