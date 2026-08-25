import { plain } from '@/text';
import { resolve } from 'node:path';
import { isPotentiallyUnsafeCommand } from '@/permissions';
import {
  asObject,
  assertOnlyArguments,
  permissionArgument,
  stringArgument,
  type ToolFactoryOptions,
} from './types';

export function createShellTool(options: ToolFactoryOptions) {
  return {
    name: 'shell',
    description:
      'Run a shell command. Commands start in the workspace and are sandboxed without network access unless elevated permission is explicitly requested and approved.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        command: { type: 'string', description: 'The shell command to run.' },
        cwd: {
          type: 'string',
          description: 'Optional working directory. Relative paths resolve from the workspace.',
        },
        timeout_ms: {
          type: 'integer',
          minimum: 1000,
          maximum: 600000,
          description: 'Optional timeout in milliseconds.',
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
      required: ['command'],
    },
    async execute(input: unknown) {
      const object = asObject(input, 'shell');
      assertOnlyArguments(object, [
        'command',
        'cwd',
        'timeout_ms',
        'permissions',
        'justification',
      ]);
      const command = stringArgument(object, 'command');
      const requested = permissionArgument(object);
      const justification =
        typeof object.justification === 'string' ? object.justification.trim() : '';
      if (object.justification !== undefined && typeof object.justification !== 'string')
        throw new Error('justification must be a string');
      if (object.cwd !== undefined && typeof object.cwd !== 'string')
        throw new Error('cwd must be a string');
      if (
        object.timeout_ms !== undefined &&
        (typeof object.timeout_ms !== 'number' ||
          !Number.isInteger(object.timeout_ms) ||
          object.timeout_ms < 1_000 ||
          object.timeout_ms > 600_000)
      )
        throw new Error('timeout_ms must be an integer between 1000 and 600000');
      if (requested === 'elevated' && !justification)
        throw new Error('justification is required for elevated shell access');
      if (options.getPlanningMode() && requested === 'elevated')
        throw new Error('elevated shell access is unavailable in planning mode');

      const potentiallyUnsafe = isPotentiallyUnsafeCommand(command);
      if (
        !(await options.authorize(
          {
            scope: 'command',
            title: requested === 'elevated' ? 'Run outside the workspace sandbox' : 'Run command',
            detail: command,
            ...(justification ? { body: [justification] } : {}),
          },
          { requested, potentiallyUnsafe },
        ))
      ) {
        throw new Error('command denied by user');
      }

      const mode = options.getPermissionMode();
      const sandboxed = options.getPlanningMode() || (mode !== 'full' && requested !== 'elevated');
      const cwd =
        typeof object.cwd === 'string' && object.cwd.trim()
          ? resolve(options.workspaceRoot, object.cwd)
          : options.workspaceRoot;
      const timeoutMs =
        typeof object.timeout_ms === 'number' && Number.isInteger(object.timeout_ms)
          ? object.timeout_ms
          : undefined;

      try {
        const { output, exitCode } = await options.runUserShell(command, {
          workspaceRoot: options.workspaceRoot,
          cwd,
          sandboxed,
          writable: !options.getPlanningMode(),
          timeoutMs,
        });
        const trimmed = plain(output).trimEnd();
        const rendered = trimmed || (exitCode === 0 ? '(no output)' : `command exited with ${exitCode}`);
        return { output: `${rendered.slice(0, 20_000)}\n\nexit code: ${exitCode}` };
      } catch (error: unknown) {
        const detail = plain(error instanceof Error ? error.message : String(error));
        return { output: `error: ${detail}` };
      }
    },
  } satisfies import('./types').Tool;
}
