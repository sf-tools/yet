import { spawn as spawnPty } from '@lydell/node-pty';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

import { USER_SHELL } from '@/config';
import { isWithinWorkspace } from '@/permissions';
import { prepareSandboxCommand, type SandboxMode } from '@/sandbox';
import { normalizePtyOutput } from '@/text';
import type { ShellResult } from '@/types';

export type ShellExecutionOptions = {
  workspaceRoot: string;
  cwd?: string;
  sandboxMode: SandboxMode;
  writableRoots?: string[];
  timeoutMs?: number;
};

export async function runUserShell(
  command: string,
  options: ShellExecutionOptions,
): Promise<ShellResult> {
  const workspaceRoot = await realpath(resolve(options.workspaceRoot));
  const cwd = await realpath(resolve(options.cwd ?? workspaceRoot));
  const writableRoots = await Promise.all(
    (options.writableRoots ?? []).map(root => realpath(resolve(root))),
  );
  const timeoutMs = Math.max(1_000, Math.min(options.timeoutMs ?? 120_000, 600_000));

  const allowedWorkingRoots = [workspaceRoot, ...writableRoots];
  if (
    options.sandboxMode !== 'danger-full-access' &&
    !allowedWorkingRoots.some(root => isWithinWorkspace(cwd, root))
  )
    throw new Error('sandboxed commands must start inside an allowed workspace root');
  const prepared = await prepareSandboxCommand({
    mode: options.sandboxMode,
    workspaceRoot,
    cwd,
    shell: USER_SHELL,
    command,
    writableRoots,
  });

  return await new Promise((resolveResult, reject) => {
    const chunks: string[] = [];
    let settled = false;

    try {
      const proc = spawnPty(prepared.executable, prepared.args, {
        name: 'xterm-256color',
        cols: Math.floor((process.stdout.columns || 120) / 1.5),
        rows: Math.floor((process.stdout.rows || 30) / 1.5),
        cwd,
        env: {
          ...prepared.env,
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
