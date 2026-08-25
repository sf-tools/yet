import { AgentApp } from '@/agent/app';
import type { HistoryEntry } from '@/types';

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleCliArgs } from '@/cli';
import { createAgentStore } from '@/store';
import { createToolRegistry } from '@/tools';
import { runUserShell } from '@/agent/shell';
import { getEarlyStdinStream } from '@/agent/early-stdin';
import { getLastAssistantResponse } from '@/agent/messages';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { OPENAI_MODEL_OPTIONS, getOpenAIProviderModelId } from '@/config';
import { builtinSlashCommands, createSlashCommandRegistry, type SlashCommandContext } from '@/agent/slash-commands';
import { createWorkspaceSandboxProfile, isPermissionMode, isPotentiallyUnsafeCommand, isWithinWorkspace, shouldPromptForTool } from '@/permissions';

function fail(error: unknown) {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exit(1);
}

process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);

let assertions = 0;
function check(condition: unknown, message: string, detail?: string): asserts condition {
  assertions += 1;
  if (!condition) throw new Error(`assertion failed: ${message}${detail ? `: ${detail}` : ''}`);
  process.stdout.write(`ok ${assertions} - ${message}\n`);
}

function equal(actual: unknown, expected: unknown, message = 'values are equal') {
  check(Object.is(actual, expected), message, `${String(actual)} !== ${String(expected)}`);
}

function deepEqual(actual: unknown, expected: unknown, message = 'values are deeply equal') {
  check(JSON.stringify(actual) === JSON.stringify(expected), message);
}

async function rejects(operation: Promise<unknown>, pattern: RegExp, message: string) {
  try {
    await operation;
  } catch (error) {
    check(pattern.test(error instanceof Error ? error.message : String(error)), message);
    return;
  }
  throw new Error('assertion failed: expected operation to reject');
}

const modelIds = OPENAI_MODEL_OPTIONS.map(model => model.id);
check(typeof AgentApp === 'function', 'the bundled TUI loads under Ant');
equal(getEarlyStdinStream(), null, 'importing the TUI does not start early stdin capture');
deepEqual(
  modelIds,
  ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-daybreak-blue-latest', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex-spark'],
  'supported model list is exact',
);
equal(getOpenAIProviderModelId('gpt-daybreak-blue-latest'), 'daybreak-blue-latest', 'daybreak model maps to its provider ID');
const commandNames = builtinSlashCommands.map(command => command.name);
deepEqual(
  commandNames,
  ['status', 'model', 'effort', 'permissions', 'plan', 'compact', 'copy', 'resume', 'rename', 'exit'],
  'slash command list is exact',
);
equal(builtinSlashCommands.find(command => command.name === 'model')?.description, 'Switch the active model.', '/model wording is provider-neutral');

const slashRegistry = createSlashCommandRegistry(builtinSlashCommands);
for (const removed of [
  'about',
  'ask',
  'btw',
  'commit',
  'copy-conversation-id',
  'copy-request-id',
  'copy-session-id',
  'image',
  'img',
  'paste-image',
  'quit',
  'reasoning',
  'review',
  'shell',
  'show-thinking',
  'showthinking',
  'simplify',
  'switch',
  'thinking',
  'toggle-auto-compact',
  'toggleautocompact',
  'tools',
]) {
  const parsed = slashRegistry.parse(`/${removed}`);
  check(parsed?.type === 'unknown', `/${removed} is no longer registered`);
}

const statusEntries: HistoryEntry[] = [];
const statusCommand = builtinSlashCommands.find(command => command.name === 'status');
check(statusCommand !== undefined, '/status is registered');
await statusCommand.execute(
  {
    store: createAgentStore(),
    getActiveToolSummaries: () => [
      { names: ['shell'], description: null },
      { names: ['apply_patch'], description: null },
    ],
    getSessionId: () => 'session-test',
    getLastRequestId: () => 'request-test',
    getThreadTitle: () => 'Status test',
    printEntries: (entries: HistoryEntry[]) => statusEntries.push(...entries),
  } as unknown as SlashCommandContext,
  { raw: '/status', invocation: 'status', argsText: '', argv: [] },
);
check(statusEntries.length === 1 && statusEntries[0]?.type === 'plain', '/status prints one block');
if (statusEntries[0]?.type === 'plain') {
  check(statusEntries[0].text.includes('gpt-5.6-sol'), '/status reports the model');
  check(statusEntries[0].text.includes('shell, apply_patch'), '/status reports active tools');
  check(statusEntries[0].text.includes('session-test'), '/status reports the session ID');
  check(statusEntries[0].text.includes('request-test'), '/status reports the request ID');
}

let copiedResponse = '';
const copyCommand = builtinSlashCommands.find(command => command.name === 'copy');
check(copyCommand !== undefined, '/copy is registered');
await copyCommand.execute(
  {
    getLastAssistantResponse: () => 'latest assistant response',
    copyToClipboard: async (text: string) => {
      copiedResponse = text;
    },
    showFooterNotice: () => {},
  } as unknown as SlashCommandContext,
  { raw: '/copy', invocation: 'copy', argsText: '', argv: [] },
);
equal(copiedResponse, 'latest assistant response', '/copy copies the latest response only');
equal(
  getLastAssistantResponse([
    { role: 'assistant', content: '<summary>compacted history</summary>' },
    { role: 'user', content: 'do the work' },
    { role: 'assistant', content: 'I am checking this now.' },
    { role: 'tool-call', callId: 'call-1', name: 'shell', input: {} },
    { role: 'tool-result', callId: 'call-1', output: 'done' },
    { role: 'assistant', content: 'The final answer.' },
  ]),
  'The final answer.',
  '/copy selects the final assistant message instead of accumulated progress text',
);

check(isPermissionMode('ask') && isPermissionMode('auto') && isPermissionMode('full'), 'modes');
check(!isPermissionMode('yolo'), 'yolo is a flag, not a stored mode');
check(isPotentiallyUnsafeCommand('rm -rf build'), 'recursive delete is unsafe');
check(isPotentiallyUnsafeCommand('curl https://example.com'), 'network command is unsafe');
check(!isPotentiallyUnsafeCommand('rg TODO src'), 'read-only search is ordinary');
check(shouldPromptForTool({ mode: 'ask', requested: 'elevated' }), 'ask prompts for elevation');
check(
  !shouldPromptForTool({ mode: 'ask', requested: 'workspace', potentiallyUnsafe: true }),
  'ask relies on the workspace sandbox for workspace actions',
);
check(shouldPromptForTool({ mode: 'auto', requested: 'workspace', potentiallyUnsafe: true }), 'auto prompts for unsafe actions');
check(!shouldPromptForTool({ mode: 'full', requested: 'elevated', potentiallyUnsafe: true }), 'full bypasses prompts');

const cli = handleCliArgs(['-m', 'gpt-5.6-terra', '--effort', 'medium', '--permissions', 'auto']);
check(cli.kind === 'start', 'valid CLI arguments start Yet');
if (cli.kind === 'start') {
  equal(cli.model, 'gpt-5.6-terra', 'CLI selects the requested model');
  equal(cli.thinkingMode, 'medium', 'CLI selects the requested effort');
  equal(cli.permissionMode, 'auto', 'CLI selects the requested permission mode');
}
const yolo = handleCliArgs(['--yolo']);
check(yolo.kind === 'start' && yolo.permissionMode === 'full', '--yolo means Full Access');

const workspace = await mkdtemp(join(tmpdir(), 'yet-tests-'));
try {
  check(isWithinWorkspace(join(workspace, 'src/file.ts'), workspace), 'child path is in workspace');
  check(!isWithinWorkspace(join(workspace, '..', 'outside'), workspace), 'parent path escapes');
  const profile = createWorkspaceSandboxProfile(workspace);
  check(profile.includes('(deny default)'), 'sandbox defaults to deny');
  check(!profile.includes('(allow network'), 'sandbox does not allow network');
  check(profile.includes('(allow file-write* (literal "/dev/null"))'), 'sandbox permits /dev/null');
  const readOnlyProfile = createWorkspaceSandboxProfile(workspace, { writable: false });
  check(!readOnlyProfile.includes(`(subpath "${workspace}")`), 'read-only sandbox denies workspace writes');
  check(readOnlyProfile.includes('(literal "/dev/null")'), 'read-only sandbox permits /dev/null');

  const recorded: string[] = [];
  let planningMode = false;
  const registry = createToolRegistry({
    workspaceRoot: workspace,
    getPermissionMode: () => 'ask',
    getPlanningMode: () => planningMode,
    getThinkingMode: () => 'auto',
    authorize: async () => true,
    runUserShell,
    recordFileMutations: files => recorded.push(...files.map(file => file.path)),
  });
  deepEqual(
    registry.list().map(tool => tool.name),
    ['shell', 'apply_patch'],
    'default tool list is exact',
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
  const shell = await registry.execute('shell', { command: 'printf sandbox-ok' });
  check(shell.output.includes('sandbox-ok'), 'shell runs in the workspace sandbox');
  check(!shell.output.includes('Operation not permitted'), 'shell skips mutating login startup files');
  check(!shell.output.includes('process exited with signal 0'), 'normal exit is not reported as a signal');
  const listed = await registry.execute('shell', { command: 'ls' });
  check(listed.output.includes('hello.txt'), 'sandboxed ls reads the workspace');
  check(!listed.output.includes('Operation not permitted'), 'sandboxed ls has no startup noise');
  check(!listed.output.includes('process exited with signal 0'), 'sandboxed ls has a clean exit');

  planningMode = true;
  deepEqual(
    registry.list().map(tool => tool.name),
    ['shell'],
    'planning mode exposes only shell',
  );
  await rejects(registry.execute('apply_patch', { patch }), /unavailable in planning mode/, 'planning mode disables apply_patch');
  await rejects(
    registry.execute('shell', {
      command: 'printf nope',
      permissions: 'elevated',
      justification: 'test',
    }),
    /unavailable in planning mode/,
    'planning mode rejects elevated shell execution',
  );
  const planningWrite = await registry.execute('shell', {
    command: 'printf cannot-write > planning-write.txt',
  });
  check(planningWrite.output.includes('exit code: 1'), 'planning shell denies file writes');
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

process.stdout.write(`1..${assertions}\n`);
