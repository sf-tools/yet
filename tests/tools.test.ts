import { BackgroundTerminalManager } from '@/agent/background-terminals';
import { createToolRegistry } from '@/tools';
import { createWorkspaceSandboxProfile, isProtectedWorkspaceMetadataPath, isWithinWorkspace, prepareSandboxCommand } from '@/permissions';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ThreadGoal } from '@/types';
import { check, deepEqual, equal, rejects } from './harness';

const workspace = await mkdtemp(join(tmpdir(), 'yet-tests-'));
try {
  check(isWithinWorkspace(join(workspace, 'src/file.ts'), workspace), 'child path is in workspace');
  check(!isWithinWorkspace(join(workspace, '..', 'outside'), workspace), 'parent path escapes');
  check(
    isProtectedWorkspaceMetadataPath(join(workspace, '.git', 'config'), workspace),
    'git metadata is protected inside writable roots',
  );
  const profile = createWorkspaceSandboxProfile(workspace);
  check(profile.includes('(deny default)'), 'sandbox defaults to deny');
  check(!profile.includes('(allow network'), 'sandbox does not allow network');
  check(profile.includes('(path "/dev/null")'), 'sandbox permits /dev/null');
  const readOnlyProfile = createWorkspaceSandboxProfile(workspace, { writable: false });
  check(
    readOnlyProfile.includes(`(deny file-write* (subpath "${workspace}"))`),
    'read-only sandbox denies workspace writes',
  );
  check(readOnlyProfile.includes('(path "/dev/null")'), 'read-only sandbox permits /dev/null');

  const fakeBin = join(workspace, 'fake-bin');
  const fakeBwrap = join(fakeBin, 'bwrap');
  await mkdir(fakeBin);
  await writeFile(fakeBwrap, '#!/bin/sh\nexit 0\n');
  await chmod(fakeBwrap, 0o755);
  const linuxSandbox = await prepareSandboxCommand({
    mode: 'workspace-write',
    workspaceRoot: workspace,
    cwd: workspace,
    shell: '/bin/sh',
    command: 'true',
    env: { PATH: fakeBin },
    platform: 'linux',
  });
  equal(linuxSandbox.backend, 'bubblewrap', 'Linux uses the bubblewrap backend');
  check(linuxSandbox.args.includes('--unshare-net'), 'bubblewrap creates a network namespace');
  check(
    linuxSandbox.args.some(
      (value, index) =>
        value === '--bind' &&
        linuxSandbox.args[index + 1] === workspace &&
        linuxSandbox.args[index + 2] === workspace,
    ),
    'bubblewrap mounts the workspace writable',
  );

  const recorded: string[] = [];
  let planningMode = false;
  let currentGoal: ThreadGoal | null = null;
  const terminalManager = new BackgroundTerminalManager();
  const registry = createToolRegistry({
    workspaceRoot: workspace,
    getPermissionMode: () => 'ask',
    getPlanningMode: () => planningMode,
    getThinkingMode: () => 'auto',
    authorize: async () => true,
    execCommand: (command, options) => terminalManager.exec(command, options),
    writeStdin: (sessionId, chars, options) => terminalManager.write(sessionId, chars, options),
    recordFileMutations: files => recorded.push(...files.map(file => file.path)),
    getGoal: () => currentGoal,
    createGoal: (objective, tokenBudget) => {
      const now = Date.now();
      currentGoal = {
        objective,
        status: 'active',
        ...(tokenBudget === undefined ? {} : { tokenBudget }),
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: now,
        updatedAt: now,
      };
      return currentGoal;
    },
    updateGoal: status => {
      if (!currentGoal) throw new Error('missing goal');
      currentGoal = { ...currentGoal, status, updatedAt: Date.now() };
      return currentGoal;
    },
  });
  deepEqual(
    registry.list().map(tool => tool.name),
    ['exec_command', 'write_stdin', 'update_plan', 'apply_patch', 'get_goal', 'create_goal', 'update_goal'],
    'default tool list is exact',
  );
  equal(
    (await registry.execute('update_plan', {
      plan: [{ step: 'Run the tests', status: 'in_progress' }],
    })).output,
    'Plan updated',
    'update_plan accepts a valid checklist',
  );
  const createdGoal = JSON.parse((await registry.execute('create_goal', {
    objective: 'Finish the registry tests',
    token_budget: 10_000,
  })).output) as { status?: string; remaining_tokens?: number };
  equal(createdGoal.status, 'active', 'create_goal creates active harness goal state');
  equal(createdGoal.remaining_tokens, 10_000, 'create_goal reports the remaining token budget');
  const completedGoal = JSON.parse((await registry.execute('update_goal', {
    status: 'complete',
  })).output) as { status?: string };
  equal(completedGoal.status, 'complete', 'update_goal records a terminal goal status');
  await rejects(
    registry.execute('update_plan', {
      plan: [
        { step: 'First', status: 'in_progress' },
        { step: 'Second', status: 'in_progress' },
      ],
    }),
    /at most one/,
    'update_plan rejects multiple in-progress steps',
  );

  const patch = ['--- /dev/null', '+++ b/hello.txt', '@@ -0,0 +1,1 @@', '+hello from yet'].join('\n');
  const result = await registry.execute('apply_patch', { patch });
  check(result.output.includes('hello.txt'), 'apply_patch reports the changed path');
  equal(await readFile(join(workspace, 'hello.txt'), 'utf8'), 'hello from yet\n', 'apply_patch writes the expected content');
  deepEqual(recorded, [join(await realpath(workspace), 'hello.txt')], 'apply_patch records the changed file');

  await rejects(
    registry.execute('apply_patch', {
      patch: ['--- /dev/null', '+++ b/../escape.txt', '@@ -0,0 +1,1 @@', '+nope'].join('\n'),
    }),
    /escapes the workspace/,
    'apply_patch rejects paths outside the workspace',
  );
  await rejects(
    registry.execute('apply_patch', {
      patch: ['--- /dev/null', '+++ b/.git/config', '@@ -0,0 +1,1 @@', '+nope'].join('\n'),
    }),
    /protected workspace metadata/,
    'apply_patch rejects protected workspace metadata',
  );
  await mkdir(join(workspace, '.git'));
  const metadataWrite = await registry.execute('exec_command', {
    cmd: 'printf denied > .git/config',
  });
  check(metadataWrite.output.includes('"exit_code":1'), 'sandbox denies writes to git metadata');
  const shell = await registry.execute('exec_command', { cmd: 'printf sandbox-ok' });
  check(shell.output.includes('sandbox-ok'), 'exec command runs in the workspace sandbox');
  check(!shell.output.includes('Operation not permitted'), 'exec command skips mutating login startup files');
  check(!shell.output.includes('process exited with signal 0'), 'normal exit is not reported as a signal');
  const listed = await registry.execute('exec_command', { cmd: 'ls' });
  check(listed.output.includes('hello.txt'), 'sandboxed ls reads the workspace');
  check(!listed.output.includes('Operation not permitted'), 'sandboxed ls has no startup noise');
  check(!listed.output.includes('process exited with signal 0'), 'sandboxed ls has a clean exit');

  const yielded = await registry.execute('exec_command', {
    cmd: 'printf ready; sleep 0.5; printf done',
    yield_time_ms: 250,
  });
  const yieldedResult = JSON.parse(yielded.output) as {
    output: string;
    session_id?: number;
  };
  check(yieldedResult.output.includes('ready'), 'long commands yield their initial PTY output');
  check(typeof yieldedResult.session_id === 'number', 'long commands yield a background session ID');
  equal(terminalManager.list().length, 1, 'yielded commands appear in /ps state');
  const completed = await registry.execute('write_stdin', {
    session_id: yieldedResult.session_id,
    yield_time_ms: 3_000,
  });
  const completedResult = JSON.parse(completed.output) as {
    output: string;
    exit_code?: number;
  };
  check(completedResult.output.includes('done'), 'write_stdin returns unread background output');
  equal(completedResult.exit_code, 0, 'write_stdin reports the background command exit code');
  equal(terminalManager.list().length, 0, 'completed commands leave /ps state');

  if (process.platform === 'darwin' && existsSync('/usr/bin/nc')) {
    const server = createServer(socket => socket.end());
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(0, '127.0.0.1', resolveListen);
    });
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('test server has no TCP port');
      const networkAttempt = await registry.execute('exec_command', {
        cmd: `/usr/bin/nc -z 127.0.0.1 ${address.port}`,
      });
      check(networkAttempt.output.includes('"exit_code":1'), 'sandbox denies local TCP access');
    } finally {
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close(error => (error ? rejectClose(error) : resolveClose()));
      });
    }
  }

  planningMode = true;
  deepEqual(
    registry.list().map(tool => tool.name),
    ['exec_command', 'write_stdin', 'update_plan', 'get_goal', 'create_goal', 'update_goal'],
    'planning mode removes only the mutating file tool',
  );
  await rejects(registry.execute('apply_patch', { patch }), /unavailable in planning mode/, 'planning mode disables apply_patch');
  await rejects(
    registry.execute('exec_command', {
      cmd: 'printf nope',
      permissions: 'elevated',
      justification: 'test',
    }),
    /unavailable in planning mode/,
    'planning mode rejects elevated shell execution',
  );
  const planningWrite = await registry.execute('exec_command', {
    cmd: 'printf cannot-write > planning-write.txt',
  });
  check(planningWrite.output.includes('"exit_code":1'), 'planning command denies file writes');
  let planningWriteExists = true;
  try {
    await readFile(join(workspace, 'planning-write.txt'));
  } catch {
    planningWriteExists = false;
  }
  check(!planningWriteExists, 'planning shell did not create the file');
} finally {
  await rm(workspace, { recursive: true, force: true });
}
