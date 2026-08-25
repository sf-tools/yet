import { spawn as spawnPty } from '@lydell/node-pty';
import { resolve } from 'node:path';

import { USER_SHELL } from '@/config';
import {
  createWorkspaceSandboxProfile,
  isWithinWorkspace,
  requireSandboxExec,
  SANDBOX_EXEC_PATH,
} from '@/permissions';
import { normalizePtyOutput } from '@/text';
import type { ShellResult } from '@/types';

export type ShellExecutionOptions = {
  workspaceRoot: string;
  cwd?: string;
  sandboxed: boolean;
  writable?: boolean;
  timeoutMs?: number;
};

export async function runUserShell(
  command: string,
  options: ShellExecutionOptions,
): Promise<ShellResult> {
  const workspaceRoot = resolve(options.workspaceRoot);
  const cwd = resolve(options.cwd ?? workspaceRoot);
  const timeoutMs = Math.max(1_000, Math.min(options.timeoutMs ?? 120_000, 600_000));

  if (options.sandboxed && !isWithinWorkspace(cwd, workspaceRoot))
    throw new Error('sandboxed commands must start inside the current workspace');
  if (options.sandboxed) await requireSandboxExec();

  const executable = options.sandboxed ? SANDBOX_EXEC_PATH : USER_SHELL;
  const args = options.sandboxed
    ? [
        '-p',
        createWorkspaceSandboxProfile(workspaceRoot, { writable: options.writable }),
        USER_SHELL,
        '-c',
        command,
      ]
    : ['-c', command];

  return await new Promise((resolveResult, reject) => {
    const chunks: string[] = [];
    let settled = false;

    try {
      const proc = spawnPty(executable, args, {
        name: 'xterm-256color',
        cols: Math.floor((process.stdout.columns || 120) / 1.5),
        rows: Math.floor((process.stdout.rows || 30) / 1.5),
        cwd,
        env: {
          ...process.env,
          TERM: 'xterm-256color',
          COLORTERM: process.env.COLORTERM || 'truecolor',
          FORCE_COLOR: process.env.FORCE_COLOR || '1',
          CLICOLOR: process.env.CLICOLOR || '1',
          CLICOLOR_FORCE: process.env.CLICOLOR_FORCE || '1',
        },
      });

      const timer = setTimeout(() => {
        if (settled) return;
        chunks.push(`\ncommand timed out after ${timeoutMs}ms`);
        proc.kill();
      }, timeoutMs);
      timer.unref?.();

      const dataDisposable = proc.onData(data => chunks.push(data));
      const exitDisposable = proc.onExit(({ exitCode, signal }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        dataDisposable.dispose();
        exitDisposable.dispose();
        if (signal !== undefined && signal !== 0)
          chunks.push(`\nprocess exited with signal ${signal}`);
        resolveResult({ exitCode, output: normalizePtyOutput(chunks.join('')) });
      });
    } catch (error) {
      settled = true;
      reject(error);
    }
  });
}
