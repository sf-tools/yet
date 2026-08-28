import { AgentApp } from '@/agent/app';
import type { ChoiceRequest, HistoryEntry } from '@/types';

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleCliArgs } from '@/cli';
import { createAgentStore } from '@/store';
import { createToolRegistry } from '@/tools';
import { runUserShell } from '@/agent/shell';
import { getEarlyStdinStream } from '@/agent/early-stdin';
import { fallbackSearchMentionEntries } from '@/agent/mention-index';
import { getLastAssistantResponse } from '@/agent/messages';
import {
  acceptSkillSuggestion,
  discoverSkills,
  listSkillSuggestions,
  loadSkillInstructionMessages,
  renderSkillsCatalog,
  selectedSkills,
} from '@/agent/skills';
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { OPENAI_MODEL_OPTIONS, getOpenAIProviderModelId } from '@/config';
import { normalizeYetPreferences } from '@/config';
import { builtinSlashCommands, type SlashCommandContext } from '@/agent/slash-commands';
import {
  createWorkspaceSandboxProfile,
  isPermissionMode,
  isPotentiallyUnsafeCommand,
  isProtectedWorkspaceMetadataPath,
  isWithinWorkspace,
  prepareSandboxCommand,
  resolvePermissionProfile,
  shouldPromptForTool,
} from '@/permissions';
import {
  SessionRecorder,
  createTurnContextEvent,
  hydrateStateFromSession,
  listYetSessions,
  listYetSessionsSync,
  loadYetSession,
  persistedStateFromAgentState,
  readYetRollout,
} from '@/agent/session-storage';
import {
  createSideConversationState,
  SIDE_BOUNDARY_PROMPT,
  SIDE_DEVELOPER_INSTRUCTIONS,
} from '@/agent/side-conversation';
import {
  createProvisionalThreadTitle,
  createThreadTitlePrompt,
  parseGeneratedThreadTitle,
  startBackgroundThreadTitle,
  THREAD_TITLE_MAX_CHARS,
  THREAD_TITLE_MODEL,
  THREAD_TITLE_PROMPT_MAX_BYTES,
} from '@/agent/thread-title';
import { EntryKind } from '@/types';
import { readClipboardImage } from '@/agent/clipboard-image';
import { displayImageTokens } from '@/agent/image-tokens';
import { resolveInputBinding } from '@/agent/keybinds';
import {
  applyConfigPickerState,
  createConfigPickerState,
} from '@/agent/config-settings';
import { renderConfigPicker } from '@/render/components/config-picker';
import { createRenderContext, serializeBlock } from '@/render';
import { createTheme } from '@/theme';
import {
  BLOCK_STREAM_CATCH_UP_AGE_MS,
  BLOCK_STREAM_CATCH_UP_LINES,
  BLOCK_STREAM_TICK_MS,
  BlockStreamBuffer,
  BlockStreamPump,
} from '@/agent/block-stream';

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

deepEqual(resolveInputBinding(Buffer.from([0x16])), { type: 'pasteImage' }, 'ctrl+v requests an image paste');
deepEqual(resolveInputBinding('\u001bv'), { type: 'pasteImage' }, 'alt+v requests an image paste');
deepEqual(
  resolveInputBinding('\u001b[118;5:1u'),
  { type: 'pasteImage' },
  'kitty ctrl+v press requests one image paste',
);
equal(resolveInputBinding('\u001b[118;5:2u'), null, 'kitty ctrl+v repeat does not duplicate the image');
equal(resolveInputBinding('\u001b[118;5:3u'), null, 'kitty ctrl+v release does not duplicate the image');
deepEqual(
  resolveInputBinding(Buffer.from([0x1f])),
  { type: 'toggleSideConversation' },
  'ctrl+/ toggles the side conversation',
);
deepEqual(
  resolveInputBinding('\u001b[47;5u'),
  { type: 'toggleSideConversation' },
  'kitty ctrl+/ toggles the side conversation',
);

const clipboardPng = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const pastedClipboardImage = await readClipboardImage({
  hasImage: () => true,
  getImageBinary: async () => clipboardPng,
});
deepEqual(Array.from(pastedClipboardImage.bytes), clipboardPng, 'clipboard PNG bytes are retained');
equal(pastedClipboardImage.mediaType, 'image/png', 'clipboard images use the provider-neutral PNG media type');
await rejects(
  readClipboardImage({
    hasImage: () => false,
    getImageBinary: async () => clipboardPng,
  }),
  /no image on clipboard/,
  'an empty image clipboard reports a clear failure',
);

const imageToken = '[image:12345678]';
equal(
  displayImageTokens(`${imageToken}${imageToken}`),
  '[Image #1][Image #2]',
  'composer image tokens use compact numbered labels',
);
const imageTokenStore = createAgentStore();
imageTokenStore.replaceInput(`${imageToken} tail`, imageToken.length);
imageTokenStore.moveCursor(-1);
equal(imageTokenStore.getState().cursor, 0, 'left arrow moves across an image token atomically');
imageTokenStore.moveCursor(1);
equal(imageTokenStore.getState().cursor, imageToken.length, 'right arrow moves across an image token atomically');
check(imageTokenStore.deleteBackward(), 'backspace deletes an image token');
equal(imageTokenStore.getState().inputChars.join(''), ' tail', 'backspace removes the complete image token');

const fuzzyFileEntries = [
  { kind: 'file' as const, label: 'ant.lockb', name: 'ant.lockb', searchPath: 'ant.lockb' },
  {
    kind: 'file' as const,
    label: 'src/agent/thread-title.ts',
    name: 'thread-title.ts',
    searchPath: 'src/agent/thread-title.ts',
  },
  {
    kind: 'file' as const,
    label: 'src/render/components/transcript.ts',
    name: 'transcript.ts',
    searchPath: 'src/render/components/transcript.ts',
  },
];
deepEqual(
  fallbackSearchMentionEntries(fuzzyFileEntries, '', 10),
  [],
  'an empty @ query does not surface arbitrary files',
);
equal(
  fallbackSearchMentionEntries(fuzzyFileEntries, 'ant', 10)[0]?.label,
  'ant.lockb',
  'file fuzzing ranks a direct basename match first',
);
equal(
  fallbackSearchMentionEntries(fuzzyFileEntries, 'thtit', 10)[0]?.label,
  'src/agent/thread-title.ts',
  'file fuzzing supports non-contiguous path-aware queries',
);

const skillsHome = await mkdtemp(join(tmpdir(), 'yet-skills-'));
try {
  const skillDirectory = join(skillsHome, '.system', 'review-changes');
  await mkdir(join(skillDirectory, 'agents'), { recursive: true });
  await writeFile(
    join(skillDirectory, 'SKILL.md'),
    [
      '---',
      'name: Review Changes',
      'description: Review a code change and report actionable defects.',
      'metadata:',
      '  short-description: Find defects',
      '---',
      '',
      '# Review Changes',
      '',
      'Inspect the full diff before reporting findings.',
      '',
    ].join('\n'),
  );
  await writeFile(
    join(skillDirectory, 'agents', 'openai.yaml'),
    [
      'interface:',
      '  display_name: Review Changes',
      '  short_description: Find actionable bugs',
      'policy:',
      '  allow_implicit_invocation: false',
      '',
    ].join('\n'),
  );

  const skills = discoverSkills(skillsHome);
  equal(skills.length, 1, 'nested Codex-style skill packages are discovered');
  equal(skills[0]?.displayName, 'Review Changes', 'skill interface metadata is loaded');
  equal(skills[0]?.shortDescription, 'Find actionable bugs', 'skill UI description is loaded');
  equal(skills[0]?.allowImplicitInvocation, false, 'skill invocation policy is loaded');

  const skillSuggestions = listSkillSuggestions(Array.from('$rev'), 4, skills);
  equal(skillSuggestions[0]?.label, 'Review Changes', '$ suggestions use the skill display name');
  equal(skillSuggestions[0]?.category, 'Skill', '$ suggestions identify their catalog category');
  const skillStore = createAgentStore();
  skillStore.replaceInput('$rev', 4);
  check(
    skillSuggestions[0] !== undefined && acceptSkillSuggestion(skillStore, skillSuggestions[0]),
    'a skill suggestion can be accepted',
  );
  equal(
    skillStore.getState().inputChars.join(''),
    '$Review Changes ',
    'accepting a skill inserts its full frontmatter name',
  );

  const invokedSkills = selectedSkills('Please $Review Changes, then summarize.', skills);
  equal(invokedSkills[0]?.path, skills[0]?.path, 'skill mentions with spaces select the package');
  const loadedSkill = await loadSkillInstructionMessages(invokedSkills);
  const skillInstruction = loadedSkill.messages[0];
  check(
    skillInstruction?.role === 'user' &&
      typeof skillInstruction.content === 'string' &&
      skillInstruction.content.includes('<name>Review Changes</name>') &&
      skillInstruction.content.includes('Inspect the full diff'),
    'selected skills inject the complete SKILL.md as a user instruction',
  );
  check(
    renderSkillsCatalog(skills).includes('Use only when the user explicitly invokes this skill.'),
    'the model-visible catalog preserves explicit-only skill policy',
  );
} finally {
  await rm(skillsHome, { recursive: true, force: true });
}

const commandNames = builtinSlashCommands.map(command => command.name);
deepEqual(
  commandNames,
  ['status', 'model', 'effort', 'fast', 'permissions', 'config', 'plan', 'compact', 'copy', 'resume', 'fork', 'btw', 'rename', 'delete', 'exit'],
  'slash command list is exact',
);
equal(builtinSlashCommands.find(command => command.name === 'model')?.description, 'Switch the active model.', '/model wording is provider-neutral');

let configPickerOpened = false;
const configCommand = builtinSlashCommands.find(command => command.name === 'config');
check(configCommand !== undefined, '/config is registered');
await configCommand.execute(
  {
    openConfigPicker: async () => {
      configPickerOpened = true;
    },
  } as unknown as SlashCommandContext,
  { raw: '/config', invocation: 'config', argsText: '', argv: [] },
);
check(configPickerOpened, '/config opens the interactive settings picker');

const configStore = createAgentStore();
const configPicker = createConfigPickerState(configStore.getState());
equal(configPicker.items[0]?.enabled, false, 'configuration picker shows the current thinking value');
equal(configPicker.items[1]?.enabled, true, 'configuration picker shows the current compaction value');
const renderedConfig = serializeBlock(
  renderConfigPicker(configPicker, createRenderContext(createTheme(), false, 80, 30)),
).join('\n');
configPicker.items[0]!.enabled = true;
configPicker.items[1]!.enabled = false;
check(applyConfigPickerState(configStore, configPicker), 'configuration changes are applied');
equal(configStore.getState().showThinking, true, 'configuration updates thinking visibility');
equal(configStore.getState().autoCompactEnabled, false, 'configuration updates automatic compaction');
equal(
  normalizeYetPreferences({ showThinking: false }).showThinking,
  false,
  'thinking visibility is retained by preference normalization',
);
check(
  renderedConfig.includes('Configuration') &&
    renderedConfig.includes('[ ] Show thinking') &&
    renderedConfig.includes('Press space to select or enter to save'),
  'configuration picker uses the experimental-features list style',
);

const configApp = new AgentApp();
const configAppInternals = configApp as unknown as {
  store: ReturnType<typeof createAgentStore>;
  render(): void;
  persistPreferences(): Promise<void>;
  tryAcceptAndSubmitSlashCommandSuggestion(): Promise<boolean>;
  handleInputBinding(binding: ReturnType<typeof resolveInputBinding>): Promise<void>;
  activeSubmissionTask: Promise<void> | null;
};
configAppInternals.render = () => {};
configAppInternals.persistPreferences = async () => {};
configAppInternals.store.replaceInput('/config');
check(
  await configAppInternals.tryAcceptAndSubmitSlashCommandSuggestion(),
  'submitting /config releases the stdin handler while the picker is open',
);
check(configAppInternals.store.getState().configPicker !== null, 'configuration picker stays open for input');
await configAppInternals.handleInputBinding({ type: 'moveSuggestion', delta: 1 });
equal(configAppInternals.store.getState().configPicker?.selectedIndex, 1, 'arrow keys navigate configuration rows');
await configAppInternals.handleInputBinding({ type: 'insertText', text: ' ' });
equal(configAppInternals.store.getState().configPicker?.items[1]?.enabled, false, 'space toggles the selected setting');
await configAppInternals.handleInputBinding({ type: 'insertText', text: ' ' });
await configAppInternals.handleInputBinding({ type: 'escape' });
equal(configAppInternals.store.getState().configPicker, null, 'escape closes the configuration picker');
await configAppInternals.activeSubmissionTask;

let forkName: string | undefined;
const forkCommand = builtinSlashCommands.find(command => command.name === 'fork');
check(forkCommand !== undefined, '/fork is registered');
await forkCommand.execute(
  {
    forkCurrentSession: async (name?: string) => {
      forkName = name;
    },
  } as unknown as SlashCommandContext,
  { raw: '/fork focused child', invocation: 'fork', argsText: 'focused child', argv: ['focused', 'child'] },
);
equal(forkName, 'focused child', '/fork forwards the requested child name');

let sideQuestion: string | undefined;
const btwCommand = builtinSlashCommands.find(command => command.name === 'btw');
check(btwCommand !== undefined, '/btw is registered');
await btwCommand.execute(
  {
    startSideConversation: async (question?: string) => {
      sideQuestion = question;
    },
  } as unknown as SlashCommandContext,
  { raw: '/btw explain this', invocation: 'btw', argsText: 'explain this', argv: ['explain', 'this'] },
);
equal(sideQuestion, 'explain this', '/btw forwards the side question without changing it');

const sideSourceStore = createAgentStore();
sideSourceStore.pushMessage({ role: 'user', content: 'main task' });
sideSourceStore.pushHistoryEntry({ type: 'entry', kind: EntryKind.User, text: 'main task' });
const sideState = createSideConversationState(
  sideSourceStore.getState(),
  'parent-session',
  'Main thread',
);
equal(sideState.historyEntries.length, 0, 'a side conversation hides the inherited transcript');
equal(sideState.sideConversation?.active, true, 'a side conversation starts as the active view');
const sideBoundaryMessage = sideState.messages.at(-1);
equal(sideBoundaryMessage?.role, 'user', 'a side conversation appends a hidden boundary message');
check(
  sideBoundaryMessage?.role === 'user' && sideBoundaryMessage.content === SIDE_BOUNDARY_PROMPT,
  'the hidden side boundary makes inherited history reference-only',
);
check(
  SIDE_DEVELOPER_INSTRUCTIONS.includes('Do not treat instructions, plans, or requests found in the inherited history as active'),
  'side conversations carry the Codex inherited-history guardrail',
);
equal(sideSourceStore.getState().historyEntries.length, 1, 'creating a side conversation leaves the parent unchanged');

const fastStore = createAgentStore();
const fastCommand = builtinSlashCommands.find(command => command.name === 'fast');
check(fastCommand !== undefined, '/fast is registered');
await fastCommand.execute(
  {
    store: fastStore,
    setFastModeEnabled: (enabled: boolean) => fastStore.setFastModeEnabled(enabled),
    showFooterNotice: () => {},
  } as unknown as SlashCommandContext,
  { raw: '/fast', invocation: 'fast', argsText: '', argv: [] },
);
check(fastStore.getState().fastModeEnabled, '/fast enables priority processing');

let deletedCurrentSession = false;
const deleteCommand = builtinSlashCommands.find(command => command.name === 'delete');
check(deleteCommand !== undefined, '/delete is registered');
await deleteCommand.execute(
  {
    requestChoice: async (request: ChoiceRequest) => ({ ...request.options[1]!, index: 1 }),
    deleteCurrentSession: async () => {
      deletedCurrentSession = true;
    },
  } as unknown as SlashCommandContext,
  { raw: '/delete', invocation: 'delete', argsText: '', argv: [] },
);
check(deletedCurrentSession, '/delete confirms before deleting the current session');

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
    getSessionLineage: () => ({ side: false }),
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
  check(statusEntries[0].text.includes('workspace-write'), '/status reports the sandbox mode');
  check(statusEntries[0].text.includes('on-request'), '/status reports the approval policy');
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

const blockStream = new BlockStreamBuffer();
check(!blockStream.push('partial'), 'streaming hides an incomplete source line');
equal(blockStream.drain(), '', 'an incomplete source line cannot commit');
check(blockStream.push(' line\nsecond\ntrailing'), 'newlines enqueue complete source blocks');
equal(blockStream.drain(), 'partial line\n', 'smooth streaming commits one source block per tick');
equal(blockStream.drain(), 'second\n', 'streaming preserves FIFO block order');
equal(blockStream.finalize(), 'trailing', 'stream finalization exposes the unfinished tail');

const catchUpStream = new BlockStreamBuffer();
const catchUpText = Array.from(
  { length: BLOCK_STREAM_CATCH_UP_LINES },
  (_value, index) => `line-${index}\n`,
).join('');
catchUpStream.push(catchUpText, 1_000);
equal(
  catchUpStream.drain(1_001),
  catchUpText,
  'deep stream queues drain as one catch-up block',
);
const agedStream = new BlockStreamBuffer();
agedStream.push('old-1\nold-2\n', 2_000);
equal(
  agedStream.drain(2_000 + BLOCK_STREAM_CATCH_UP_AGE_MS),
  'old-1\nold-2\n',
  'old stream queues catch up before visible lag grows',
);

const pumpedBlocks: string[] = [];
const streamPump = new BlockStreamPump(text => pumpedBlocks.push(text));
streamPump.push('first\nsecond tail');
await new Promise(resolve => setTimeout(resolve, BLOCK_STREAM_TICK_MS * 2));
deepEqual(pumpedBlocks, ['first\n'], 'the stream pump publishes complete blocks on frame ticks');
streamPump.flush();
deepEqual(
  pumpedBlocks,
  ['first\n', 'second tail'],
  'the stream pump flushes the final incomplete block exactly once',
);
streamPump.dispose();

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
deepEqual(
  resolvePermissionProfile('ask'),
  {
    sandboxMode: 'workspace-write',
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
  },
  'Ask for approval uses the managed workspace sandbox',
);
equal(
  resolvePermissionProfile('ask', { readOnly: true }).sandboxMode,
  'read-only',
  'planning mode narrows the sandbox to read-only',
);
deepEqual(
  resolvePermissionProfile('full'),
  {
    sandboxMode: 'danger-full-access',
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
  },
  'Full Access disables both sandboxing and approvals',
);

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
  await rejects(
    registry.execute('apply_patch', {
      patch: ['--- /dev/null', '+++ b/.git/config', '@@ -0,0 +1,1 @@', '+nope'].join('\n'),
    }),
    /protected workspace metadata/,
    'apply_patch rejects protected workspace metadata',
  );
  await mkdir(join(workspace, '.git'));
  const metadataWrite = await registry.execute('shell', {
    command: 'printf denied > .git/config',
  });
  check(metadataWrite.output.includes('exit code: 1'), 'sandbox denies writes to git metadata');
  const shell = await registry.execute('shell', { command: 'printf sandbox-ok' });
  check(shell.output.includes('sandbox-ok'), 'shell runs in the workspace sandbox');
  check(!shell.output.includes('Operation not permitted'), 'shell skips mutating login startup files');
  check(!shell.output.includes('process exited with signal 0'), 'normal exit is not reported as a signal');
  const listed = await registry.execute('shell', { command: 'ls' });
  check(listed.output.includes('hello.txt'), 'sandboxed ls reads the workspace');
  check(!listed.output.includes('Operation not permitted'), 'sandboxed ls has no startup noise');
  check(!listed.output.includes('process exited with signal 0'), 'sandboxed ls has a clean exit');

  if (process.platform === 'darwin' && existsSync('/usr/bin/nc')) {
    const server = createServer(socket => socket.end());
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(0, '127.0.0.1', resolveListen);
    });
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('test server has no TCP port');
      const networkAttempt = await registry.execute('shell', {
        command: `/usr/bin/nc -z 127.0.0.1 ${address.port}`,
      });
      check(networkAttempt.output.includes('exit code: 1'), 'sandbox denies local TCP access');
    } finally {
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close(error => (error ? rejectClose(error) : resolveClose()));
      });
    }
  }

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

equal(
  createProvisionalThreadTitle('  fix   the\nUnicode 🧪 persistence writer and more  '),
  'fix the Unicode 🧪 persistence writer',
  'provisional title is immediate, normalized, Unicode-safe, and bounded',
);
equal(THREAD_TITLE_MODEL, 'gpt-5.6-luna', 'background titles use the dedicated Luna model');
equal(THREAD_TITLE_MAX_CHARS, 36, 'thread titles use the Codex display limit');
equal(THREAD_TITLE_PROMPT_MAX_BYTES, 960, 'thread title prompts use the Codex byte limit');
check(
  Buffer.byteLength(createThreadTitlePrompt('🧪'.repeat(1_000))) <= 960,
  'title prompt respects its UTF-8 byte budget',
);
equal(
  parseGeneratedThreadTitle('{"title":"  Fix rollout recovery!  "}'),
  'Fix rollout recovery',
  'structured title output is normalized',
);
equal(parseGeneratedThreadTitle('<title>wrong shape</title>'), null, 'non-JSON title output is rejected');
equal(
  parseGeneratedThreadTitle('{"title":"Valid shape","extra":true}'),
  null,
  'structured title output rejects unknown fields',
);

const neverResolvingSignal: { value: AbortSignal | null } = { value: null };
const neverResolvingTitle = startBackgroundThreadTitle({
  userMessage: 'test shutdown',
  expectedTitle: 'test shutdown',
  getCurrentTitle: () => 'test shutdown',
  applyTitle: () => {
    throw new Error('a never-resolving title should not apply');
  },
  generate: (_message, signal) => {
    neverResolvingSignal.value = signal;
    return new Promise(() => {});
  },
});
check(neverResolvingSignal.value !== null, 'background title generation starts without awaiting a result');
neverResolvingTitle.cancel();
check(neverResolvingSignal.value.aborted, 'background title generation can be abandoned during shutdown');

let resolveLateTitle!: (title: string | null) => void;
let currentTitle = 'provisional title';
const lateTitle = startBackgroundThreadTitle({
  userMessage: 'provisional title',
  expectedTitle: 'provisional title',
  getCurrentTitle: () => currentTitle,
  applyTitle: title => {
    currentTitle = title;
  },
  generate: () => new Promise(resolve => {
    resolveLateTitle = resolve;
  }),
});
currentTitle = 'Manual rename';
resolveLateTitle('Generated title');
await Promise.resolve();
await Promise.resolve();
equal(currentTitle, 'Manual rename', 'manual rename wins over a late generated title');
lateTitle.cancel();

let resolveExpectedTitle!: (title: string | null) => void;
currentTitle = 'expected provisional';
startBackgroundThreadTitle({
  userMessage: 'expected provisional',
  expectedTitle: 'expected provisional',
  getCurrentTitle: () => currentTitle,
  applyTitle: title => {
    currentTitle = title;
  },
  generate: () => new Promise(resolve => {
    resolveExpectedTitle = resolve;
  }),
});
resolveExpectedTitle('Generated replacement');
await Promise.resolve();
await Promise.resolve();
equal(currentTitle, 'Generated replacement', 'generated title replaces only its expected provisional title');

currentTitle = 'failure fallback';
startBackgroundThreadTitle({
  userMessage: 'failure fallback',
  expectedTitle: 'failure fallback',
  getCurrentTitle: () => currentTitle,
  applyTitle: title => {
    currentTitle = title;
  },
  generate: async () => {
    throw new Error('title service unavailable');
  },
});
await Promise.resolve();
await Promise.resolve();
equal(currentTitle, 'failure fallback', 'failed title generation leaves the provisional title');

const sessionHome = await mkdtemp(join(tmpdir(), 'yet-sessions-'));
try {
  const emptyRecorder = await SessionRecorder.open({
    sessionId: 'empty-session',
    cwd: sessionHome,
    yetHome: sessionHome,
  });
  const emptyRolloutPath = emptyRecorder.rolloutPath;
  await emptyRecorder.close();
  check(!existsSync(emptyRolloutPath), 'empty sessions do not materialize rollout files');

  const deletedRecorder = await SessionRecorder.open({
    sessionId: 'deleted-session',
    cwd: sessionHome,
    yetHome: sessionHome,
  });
  deletedRecorder.record({
    type: 'transcript_entry',
    payload: { entries: [{ type: 'plain', text: 'delete me' }] },
  });
  await deletedRecorder.deleteSession();
  check(!existsSync(deletedRecorder.rolloutPath), 'session deletion removes the canonical rollout');
  check(
    !(await listYetSessions({ yetHome: sessionHome })).some(
      entry => entry.sessionId === 'deleted-session',
    ),
    'session deletion removes the session from the resume index',
  );

  const recorder = await SessionRecorder.open({
    sessionId: 'event-session',
    cwd: sessionHome,
    yetHome: sessionHome,
  });
  check(
    /\/sessions\/\d{4}\/\d{2}\/\d{2}\/rollout-[^/]+-event-session\.jsonl$/.test(
      recorder.rolloutPath.replaceAll('\\', '/'),
    ),
    'new sessions use the dated rollout directory layout',
  );
  await rejects(
    SessionRecorder.open({
      sessionId: 'event-session',
      cwd: sessionHome,
      rolloutPath: recorder.rolloutPath,
      yetHome: sessionHome,
    }),
    /already open/,
    'a second process writer cannot open the same session',
  );

  const contextStore = createAgentStore();
  contextStore.setCurrentModel('gpt-5.6-terra');
  contextStore.setThinkingMode('medium');
  recorder.record({
    type: 'thread_name_updated',
    payload: { name: 'Durable events', source: 'provisional' },
  });
  recorder.record(createTurnContextEvent(contextStore.getState()));
  recorder.record({
    type: 'user_message',
    payload: {
      entries: [{ type: 'entry', kind: EntryKind.User, text: 'Build durable sessions' }],
    },
  });
  recorder.record({
    type: 'user_message',
    payload: { messages: [{ role: 'user', content: 'Build durable sessions' }] },
  });
  recorder.record({
    type: 'tool_call',
    payload: {
      entry: {
        type: 'tool',
        toolCallId: 'tool-1',
        toolName: 'shell',
        input: { command: 'pwd' },
        status: 'running',
      },
    },
  });
  recorder.record({
    type: 'tool_result',
    payload: {
      entry: {
        type: 'tool',
        toolCallId: 'tool-1',
        toolName: 'shell',
        input: { command: 'pwd' },
        output: sessionHome,
        status: 'completed',
      },
    },
  });
  recorder.record({
    type: 'reasoning',
    payload: {
      entries: [{ type: 'entry', kind: EntryKind.Reasoning, text: 'Inspect the writer.' }],
    },
  });
  recorder.record({
    type: 'assistant_message',
    payload: {
      messages: [{ role: 'assistant', content: 'The writer is ready.' }],
      entries: [{ type: 'entry', kind: EntryKind.Assistant, text: 'The writer is ready.' }],
    },
  });
  const compactedMessages = [
    { role: 'assistant' as const, content: '<summary>durable compacted context</summary>' },
  ];
  recorder.record({
    type: 'compacted',
    payload: {
      messages: compactedMessages,
      entry: {
        type: 'compacted',
        summary: 'durable compacted context',
        previousMessageCount: 2,
        nextMessageCount: 1,
        automatic: false,
      },
      usage: { inputTokens: 8, outputTokens: 3, reasoningTokens: 1, cachedInputTokens: 0 },
    },
  });
  recorder.record({
    type: 'transcript_entry',
    payload: { entries: [{ type: 'plain', text: 'local transcript note' }] },
  });
  recorder.record({
    type: 'usage_updated',
    payload: {
      usage: { inputTokens: 10, outputTokens: 4, reasoningTokens: 2, cachedInputTokens: 1 },
      totalCost: 0,
    },
  });
  for (let index = 0; index < 25; index += 1) {
    recorder.record({
      type: 'transcript_entry',
      payload: { entries: [{ type: 'plain', text: `ordered-${index}` }] },
    });
  }
  await recorder.close();

  if (process.platform !== 'win32') {
    equal(statSync(recorder.rolloutPath).mode & 0o777, 0o600, 'rollouts are private to the user');
  }

  const rollout = await readYetRollout(recorder.rolloutPath);
  equal(rollout[0]?.type, 'session_meta', 'rollout starts with session metadata');
  deepEqual(
    rollout.map(line => line.ordinal),
    rollout.map((_line, index) => index),
    'queued rollout writes preserve contiguous ordinal order',
  );
  deepEqual(
    rollout
      .filter(line => line.type === 'transcript_entry')
      .slice(-25)
      .map(line => line.type === 'transcript_entry' ? line.payload.entries[0] : null)
      .map(entry => entry?.type === 'plain' ? entry.text : null),
    Array.from({ length: 25 }, (_value, index) => `ordered-${index}`),
    'concurrent caller appends preserve event order',
  );

  const loaded = await loadYetSession('event-session', { yetHome: sessionHome });
  check(loaded !== null, 'rollout session can be loaded');
  equal(loaded.name, 'Durable events', 'rollout restores the session title');
  equal(loaded.state.currentModel, 'gpt-5.6-terra', 'rollout restores the latest turn model');
  deepEqual(loaded.state.messages, compactedMessages, 'compaction replaces replayed model context');
  check(
    loaded.state.historyEntries.some(entry => entry.type === 'compacted'),
    'compaction metadata survives rollout replay',
  );
  check(
    loaded.state.historyEntries.some(
      entry => entry.type === 'tool' && entry.toolCallId === 'tool-1' && entry.status === 'completed',
    ),
    'rollout reducer applies tool result updates',
  );

  const forkState = createAgentStore(hydrateStateFromSession(loaded));
  forkState.pushHistoryEntry({
    type: 'forked',
    parentSessionId: loaded.sessionId,
    parentTitle: loaded.name,
  });
  forkState.pushHistoryEntry({
    type: 'resume_hint',
    command: `yet --resume=${loaded.sessionId}`,
  });
  const forkRecorder = await SessionRecorder.open({
    sessionId: 'forked-session',
    cwd: sessionHome,
    yetHome: sessionHome,
    parentSessionId: loaded.sessionId,
    forkPoint: rollout.at(-1)?.ordinal ?? 0,
    title: 'Forked child',
  });
  forkRecorder.record({
    type: 'fork_snapshot',
    payload: { state: persistedStateFromAgentState(forkState.getState()) },
  });
  forkRecorder.record({
    type: 'thread_name_updated',
    payload: { name: 'Forked child', source: 'manual' },
  });
  await forkRecorder.close();

  const forked = await loadYetSession('forked-session', { yetHome: sessionHome });
  check(forked !== null, 'a forked session can be loaded');
  equal(forked.parentSessionId, loaded.sessionId, 'a fork records its parent session ID');
  equal(forked.forkPoint, rollout.at(-1)?.ordinal ?? 0, 'a fork records its source rollout point');
  deepEqual(forked.state.messages, loaded.state.messages, 'a fork inherits the parent model context');
  check(
    forked.state.historyEntries.some(
      entry => entry.type === 'forked' && entry.parentSessionId === loaded.sessionId,
    ),
    'a fork persists its visible lineage event',
  );
  check(
    forked.state.historyEntries.some(
      entry => entry.type === 'resume_hint' && entry.command === `yet --resume=${loaded.sessionId}`,
    ),
    'a fork persists the parent resume hint',
  );
  const indexedFork = (await listYetSessions({ yetHome: sessionHome })).find(
    entry => entry.sessionId === 'forked-session',
  );
  equal(indexedFork?.parentSessionId, loaded.sessionId, 'the resume index retains fork lineage');

  const indexed = listYetSessionsSync({ yetHome: sessionHome });
  const indexedEventSession = indexed.find(entry => entry.sessionId === 'event-session');
  equal(indexedEventSession?.title, 'Durable events', 'resume listing reads title metadata from the index');
  equal(indexedEventSession?.preview, 'Build durable sessions', 'resume index stores the first user preview');

  const validRolloutContents = await readFile(recorder.rolloutPath, 'utf8');
  await writeFile(recorder.rolloutPath, 'x'.repeat(Buffer.byteLength(validRolloutContents)));
  check(
    listYetSessionsSync({ yetHome: sessionHome }).some(entry => entry.sessionId === 'event-session'),
    'healthy resume index does not parse every rollout body',
  );
  await writeFile(recorder.rolloutPath, validRolloutContents);

  await rm(join(sessionHome, 'session_index.jsonl'), { force: true });
  check(
    (await listYetSessions({ yetHome: sessionHome })).some(
      entry => entry.sessionId === 'event-session',
    ),
    'missing session index is rebuilt from canonical rollouts',
  );

  await writeFile(join(sessionHome, 'session_index.jsonl'), 'not valid json\n');
  check(
    (await listYetSessions({ yetHome: sessionHome })).some(
      entry => entry.sessionId === 'event-session',
    ),
    'a corrupt session index is rebuilt from canonical rollouts',
  );

  const indexedRollout = await readYetRollout(recorder.rolloutPath);
  const staleIndexTitleLine = {
    timestamp: new Date().toISOString(),
    ordinal: (indexedRollout.at(-1)?.ordinal ?? -1) + 1,
    type: 'thread_name_updated',
    payload: { name: 'Recovered index title', source: 'manual' },
  };
  await appendFile(recorder.rolloutPath, `${JSON.stringify(staleIndexTitleLine)}\n`);
  equal(
    (await listYetSessions({ yetHome: sessionHome })).find(
      entry => entry.sessionId === 'event-session',
    )?.title,
    'Recovered index title',
    'index lag after a canonical write is repaired from the changed rollout',
  );
  const staleGeneratedTitleLine = {
    timestamp: new Date().toISOString(),
    ordinal: staleIndexTitleLine.ordinal + 1,
    type: 'thread_name_updated',
    payload: {
      name: 'Stale generated title',
      source: 'generated',
      expectedName: 'Durable events',
    },
  };
  await appendFile(recorder.rolloutPath, `${JSON.stringify(staleGeneratedTitleLine)}\n`);
  equal(
    (await listYetSessions({ yetHome: sessionHome })).find(
      entry => entry.sessionId === 'event-session',
    )?.title,
    'Recovered index title',
    'rollout replay rejects a generated title after a manual rename',
  );

  await appendFile(recorder.rolloutPath, '{"timestamp":"partial');
  const resumedRecorder = await SessionRecorder.open({
    sessionId: 'event-session',
    cwd: sessionHome,
    rolloutPath: recorder.rolloutPath,
    yetHome: sessionHome,
  });
  resumedRecorder.record({
    type: 'transcript_entry',
    payload: { entries: [{ type: 'plain', text: 'after recovery' }] },
  });
  await resumedRecorder.close();
  const repairedContents = await readFile(recorder.rolloutPath, 'utf8');
  check(!repairedContents.includes('"timestamp":"partial'), 'truncated final JSONL record is removed');
  check(repairedContents.includes('after recovery'), 'writing continues after partial-tail recovery');

  const duplicateOrdinalPath = join(sessionHome, 'duplicate-ordinal.jsonl');
  await writeFile(
    duplicateOrdinalPath,
    [
      JSON.stringify({
        timestamp: new Date().toISOString(),
        ordinal: 7,
        type: 'transcript_entry',
        payload: { entries: [{ type: 'plain', text: 'first attempt' }] },
      }),
      JSON.stringify({
        timestamp: new Date().toISOString(),
        ordinal: 7,
        type: 'transcript_entry',
        payload: { entries: [{ type: 'plain', text: 'retry attempt' }] },
      }),
      '',
    ].join('\n'),
  );
  const duplicateOrdinalLines = await readYetRollout(duplicateOrdinalPath);
  equal(duplicateOrdinalLines.length, 1, 'same-ordinal retry records are deduplicated');
  equal(
    duplicateOrdinalLines[0]?.type === 'transcript_entry' &&
      duplicateOrdinalLines[0].payload.entries[0]?.type === 'plain'
      ? duplicateOrdinalLines[0].payload.entries[0].text
      : null,
    'retry attempt',
    'the latest complete same-ordinal retry wins',
  );

  const interruptedRecorder = await SessionRecorder.open({
    sessionId: 'interrupted-session',
    cwd: sessionHome,
    yetHome: sessionHome,
  });
  interruptedRecorder.record({
    type: 'tool_call',
    payload: {
      entry: {
        type: 'tool',
        toolCallId: 'interrupted-tool',
        toolName: 'shell',
        input: { command: 'sleep 1' },
        status: 'running',
      },
      message: {
        role: 'tool-call',
        callId: 'interrupted-tool',
        name: 'shell',
        input: { command: 'sleep 1' },
      },
    },
  });
  await interruptedRecorder.close();
  const interrupted = await loadYetSession('interrupted-session', {
    yetHome: sessionHome,
  });
  check(
    interrupted?.state.historyEntries.some(
      entry =>
        entry.type === 'tool' &&
        entry.toolCallId === 'interrupted-tool' &&
        entry.status === 'failed',
    ),
    'unmatched tool calls resume as interrupted failures',
  );
  check(
    interrupted?.state.messages.some(
      message => message.role === 'tool-call' && message.callId === 'interrupted-tool',
    ),
    'completed tool-call model context survives an interrupted turn',
  );
  check(
    interrupted?.state.messages.some(
      message =>
        message.role === 'tool-result' &&
        message.callId === 'interrupted-tool' &&
        message.output.includes('interrupted'),
    ),
    'interrupted tool calls receive a synthetic failed model result',
  );

} finally {
  await rm(sessionHome, { recursive: true, force: true });
}

process.stdout.write(`1..${assertions}\n`);
