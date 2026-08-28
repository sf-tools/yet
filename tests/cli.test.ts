import { formatSessionUsage } from '@/agent/session-summary';
import { handleCliArgs } from '@/cli';
import { resolvePermissionProfile, isPotentiallyUnsafeCommand, shouldPromptForTool } from '@/permissions';
import { renderExitSummary, serializeBlock } from '@/render';
import { check, deepEqual, equal } from './harness';

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

const cli = handleCliArgs([
  '-m',
  'gpt-5.6-terra',
  '--effort',
  'medium',
  '--permissions',
  'auto',
  'fix',
  'the tests',
]);
check(cli.kind === 'start', 'valid CLI arguments start Yet');
if (cli.kind === 'start') {
  equal(cli.model, 'gpt-5.6-terra', 'CLI selects the requested model');
  equal(cli.thinkingMode, 'medium', 'CLI selects the requested effort');
  equal(cli.permissionMode, 'auto', 'CLI selects the requested permission mode');
  equal(cli.prompt, 'fix the tests', 'CLI forwards positional arguments as the initial prompt');
}
const yolo = handleCliArgs(['--yolo']);
check(yolo.kind === 'start' && yolo.permissionMode === 'full', '--yolo means Full Access');

const resumePickerCli = handleCliArgs(['resume']);
deepEqual(
  resumePickerCli,
  { kind: 'start', resume: { last: false, showAll: false } },
  'the positional resume command opens the inline picker',
);
const namedResumeCli = handleCliArgs(['resume', 'Durable events', 'continue', 'working']);
deepEqual(
  namedResumeCli,
  {
    kind: 'start',
    prompt: 'continue working',
    resume: { reference: 'Durable events', last: false, showAll: false },
  },
  'the positional resume command accepts a session reference and initial prompt',
);
const lastResumeCli = handleCliArgs(['resume', '--last', '--all', 'continue', 'working']);
deepEqual(
  lastResumeCli,
  {
    kind: 'start',
    prompt: 'continue working',
    resume: { last: true, showAll: true },
  },
  'resume --last accepts an initial prompt and all-folder scope',
);

const usageFixture = {
  inputTokens: 12_000,
  outputTokens: 345,
  reasoningTokens: 40,
  cachedInputTokens: 2_000,
};
equal(
  formatSessionUsage(usageFixture),
  'Token usage: total=10,345 input=10,000 (+ 2,000 cached) output=345 (reasoning 40)',
  'session token usage uses the Codex exit-summary format',
);
const exitSummary = serializeBlock(
  renderExitSummary(usageFixture, 'yet resume session-123'),
).join('\n');
check(
  exitSummary.includes('Token usage: total=10,345') &&
    exitSummary.includes('To continue this session, run yet resume session-123'),
  'normal exit output includes cumulative tokens and the positional resume command',
);
equal(
  serializeBlock(
    renderExitSummary(
      { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedInputTokens: 0 },
      null,
    ),
  ).join('\n'),
  '',
  'destructive session exits omit empty usage and resume hints',
);
