import { resolve } from 'node:path';

import { isPotentiallyUnsafeCommand, resolvePermissionProfile } from '@/permissions';
import { plain } from '@/text';
import {
  asObject,
  assertOnlyArguments,
  permissionArgument,
  stringArgument,
  type ToolFactoryOptions,
} from './types';

function optionalInteger(
  object: Record<string, unknown>,
  name: string,
  minimum: number,
  maximum: number,
) {
  const value = object[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum)
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  return value;
}

function encodeResult(result: Awaited<ReturnType<ToolFactoryOptions['execCommand']>>) {
  return JSON.stringify({
    output: result.output,
    wall_time_seconds: result.wallTimeSeconds,
    ...(result.exitCode === undefined ? {} : { exit_code: result.exitCode }),
    ...(result.sessionId === undefined ? {} : { session_id: result.sessionId }),
    ...(result.originalTokenCount === undefined
      ? {}
      : { original_token_count: result.originalTokenCount }),
  });
}

export function createExecCommandTool(options: ToolFactoryOptions) {
  return {
    name: 'exec_command',
    description:
      'Runs a command in a PTY, returning output or a session ID for ongoing interaction.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        cmd: { type: 'string', description: 'Shell command to execute.' },
        workdir: {
          type: 'string',
          description: 'Working directory for the command. Defaults to the turn cwd.',
        },
        yield_time_ms: {
          type: 'integer',
          minimum: 250,
          maximum: 30000,
          description: 'Wait before yielding output. Defaults to 10000 ms.',
        },
        max_output_tokens: {
          type: 'integer',
          minimum: 250,
          maximum: 50000,
          description: 'Output token budget. Defaults to 10000 tokens.',
        },
        permissions: {
          type: 'string',
          enum: ['workspace', 'elevated'],
          description: 'Use elevated only for network access or work outside the workspace.',
        },
        justification: {
          type: 'string',
          description: 'Required explanation when elevated permission is requested.',
        },
      },
      required: ['cmd'],
    },
    async execute(input: unknown) {
      const object = asObject(input, 'exec_command');
      assertOnlyArguments(object, [
        'cmd',
        'workdir',
        'yield_time_ms',
        'max_output_tokens',
        'permissions',
        'justification',
      ]);
      const command = stringArgument(object, 'cmd');
      const requested = permissionArgument(object);
      const justification =
        typeof object.justification === 'string' ? object.justification.trim() : '';
      if (object.justification !== undefined && typeof object.justification !== 'string')
        throw new Error('justification must be a string');
      if (object.workdir !== undefined && typeof object.workdir !== 'string')
        throw new Error('workdir must be a string');
      const yieldTimeMs = optionalInteger(object, 'yield_time_ms', 250, 30_000);
      const maxOutputTokens = optionalInteger(object, 'max_output_tokens', 250, 50_000);
      if (requested === 'elevated' && !justification)
        throw new Error('justification is required for elevated command execution');
      if (options.getPlanningMode() && requested === 'elevated')
        throw new Error('elevated command execution is unavailable in planning mode');

      if (
        !(await options.authorize(
          {
            scope: 'command',
            title: requested === 'elevated' ? 'Run outside the workspace sandbox' : 'Run command',
            detail: command,
            ...(justification ? { body: [justification] } : {}),
          },
          { requested, potentiallyUnsafe: isPotentiallyUnsafeCommand(command) },
        ))
      ) {
        throw new Error('command denied by user');
      }

      const profile = resolvePermissionProfile(options.getPermissionMode(), {
        readOnly: options.getPlanningMode(),
      });
      const sandboxMode = requested === 'elevated' ? 'danger-full-access' : profile.sandboxMode;
      const cwd =
        typeof object.workdir === 'string' && object.workdir.trim()
          ? resolve(options.workspaceRoot, object.workdir)
          : options.workspaceRoot;

      try {
        const result = await options.execCommand(command, {
          workspaceRoot: options.workspaceRoot,
          cwd,
          sandboxMode,
          yieldTimeMs,
          maxOutputTokens,
        });
        return { output: encodeResult(result) };
      } catch (error) {
        return { output: JSON.stringify({ error: plain(error instanceof Error ? error.message : String(error)) }) };
      }
    },
  } satisfies import('./types').Tool;
}
