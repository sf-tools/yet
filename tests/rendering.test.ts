import { getLastAssistantResponse } from '@/agent/messages';
import {
  BLOCK_STREAM_CATCH_UP_AGE_MS,
  BLOCK_STREAM_CATCH_UP_LINES,
  BLOCK_STREAM_TICK_MS,
  BlockStreamBuffer,
  BlockStreamPump,
} from '@/agent/block-stream';
import { isPermissionMode } from '@/permissions';
import { renderHistoryEntry } from '@/render/components/entry';
import { renderComposer } from '@/render/components/composer';
import { renderStatusIndicator } from '@/render/components/status-indicator';
import { renderCommandActivity } from '@/render/components/tools/command-activity';
import { renderTranscriptOverlay } from '@/render/components/transcript-overlay';
import { renderMarkdown } from '@/render/markdown';
import {
  hideWebLinkDestination,
  osc8Hyperlink,
} from '@/render/terminal-hyperlinks';
import { createRenderContext, serializeBlock } from '@/render';
import { createAgentStore } from '@/store';
import { createTheme } from '@/theme';
import { stripAnsi, widthOf } from '@/text';
import { EntryKind, type ToolHistoryEntry } from '@/types';
import { check, deepEqual, equal } from './harness';

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

const renderContext = createRenderContext(createTheme(), false, 80, 30);
const tabbedComposerLines = serializeBlock(
  renderComposer(
    {
      inputChars: Array.from('1234\t5'),
      pasteRanges: [],
      cursor: 6,
    },
    renderContext,
  ).block,
);
check(
  tabbedComposerLines.every(renderedLine => !renderedLine.includes('\t')) &&
    tabbedComposerLines.every(renderedLine => widthOf(renderedLine) === renderContext.width + 1),
  'composer tabs render as one cell without clipping the panel edge',
);
const pastedComposer = serializeBlock(
  renderComposer(
    {
      inputChars: Array.from('first\nsecond\n'),
      pasteRanges: [{ start: 0, end: 'first\nsecond\n'.length }],
      cursor: 'first\nsecond\n'.length,
    },
    renderContext,
  ).block,
).join('\n');
check(
  stripAnsi(pastedComposer).includes('[pasted +2 lines]') &&
    !stripAnsi(pastedComposer).includes('paste #'),
  'multiline paste tokens use the lowercase Codex-style line-count label',
);
const renderedMarkdown = serializeBlock(
  renderMarkdown(
    [
      '# Heading',
      '',
      'Text with **bold** and `inline code`.',
      '',
      '- first',
      '- second',
      '',
      '> quoted',
      '',
      '```ts',
      'const answer = 42;',
      '```',
      '',
      '| Name | Result |',
      '| --- | ---: |',
      '| Yet | ready |',
    ].join('\n'),
    renderContext,
    76,
  ),
).join('\n');
check(
  renderedMarkdown.includes(
    '# Heading\n\nText with bold and inline code.\n\n- first\n- second\n\n> quoted\n\nconst answer = 42;',
  ),
  'Markdown uses Codex heading, list, quote, inline-code, and code-block layout',
);
check(
  renderedMarkdown.includes('Name') &&
    renderedMarkdown.includes('Result') &&
    renderedMarkdown.includes('━━━━'),
  'Markdown tables use the Codex column and header-separator layout',
);
check(
  hideWebLinkDestination(
    'https://yet.dev/',
    { TERM: 'xterm-256color', TERM_PROGRAM: 'ghostty' },
    true,
  ),
  'Ghostty uses clickable Markdown labels without a visible destination suffix',
);
const linkedLabel = osc8Hyperlink('https://yet.dev/', 'Yet');
check(
  linkedLabel.includes('\u001b]8;;https://yet.dev/\u0007') && widthOf(linkedLabel) === 3,
  'terminal hyperlinks are clickable without changing visible text width',
);
const renderedMarkdownLink = serializeBlock(
  renderMarkdown('[Yet](https://yet.dev/)', renderContext, 76),
).join('\n');
check(
  renderedMarkdownLink.includes('\u001b]8;;https://yet.dev/\u0007'),
  'Markdown links always retain their terminal click target',
);
if (hideWebLinkDestination('https://yet.dev/')) {
  check(
    stripAnsi(renderedMarkdownLink) === 'Yet' && renderedMarkdownLink.includes('\u001b]8;;'),
    'supported terminals render a clickable cyan label without the raw Markdown destination',
  );
} else {
  check(
    stripAnsi(renderedMarkdownLink) === 'Yet (https://yet.dev/)',
    'non-interactive and unsupported terminals retain the Markdown destination',
  );
}

const commandHistory: ToolHistoryEntry[] = [
  {
    type: 'tool',
    toolCallId: 'command-1',
    toolName: 'exec_command',
    input: { cmd: 'printf first' },
    output: JSON.stringify({ output: 'first', exit_code: 0, wall_time_seconds: 0.01 }),
    status: 'completed',
  },
  {
    type: 'tool',
    toolCallId: 'command-2',
    toolName: 'exec_command',
    input: { cmd: 'printf second' },
    output: JSON.stringify({ output: 'second', exit_code: 0, wall_time_seconds: 0.02 }),
    status: 'completed',
  },
];
equal(
  serializeBlock(renderCommandActivity(commandHistory, renderContext)).join('\n'),
  ' • Ran 2 commands · ctrl + t to view transcript',
  'completed command groups collapse to the Codex transcript summary',
);
const renderedExploration = serializeBlock(
  renderCommandActivity(
    [
      {
        type: 'tool',
        toolCallId: 'search-1',
        toolName: 'exec_command',
        input: { cmd: "rg -n 'update_plan' src" },
        output: JSON.stringify({ output: 'src/tools/index.ts:1', exit_code: 0 }),
        status: 'completed',
      },
      {
        type: 'tool',
        toolCallId: 'read-1',
        toolName: 'exec_command',
        input: { cmd: "sed -n '1,120p' src/tools/index.ts" },
        output: JSON.stringify({ output: 'source', exit_code: 0 }),
        status: 'completed',
      },
    ],
    renderContext,
  ),
).join('\n');
check(
  renderedExploration.includes('• Explored') &&
    renderedExploration.includes('Search update_plan in src') &&
    renderedExploration.includes('Read src/tools/index.ts'),
  'read and search commands collapse into the Codex Explored cell',
);
const renderedSingleCommand = serializeBlock(
  renderCommandActivity(
    [{
      type: 'tool',
      toolCallId: 'single-1',
      toolName: 'exec_command',
      input: { cmd: 'npm test' },
      output: JSON.stringify({ output: 'one\ntwo\nthree\nfour\nfive\nsix', exit_code: 0 }),
      status: 'completed',
    }],
    renderContext,
  ),
).join('\n');
check(
  renderedSingleCommand.includes('• Ran npm test') &&
    renderedSingleCommand.includes('… +2 lines (ctrl + t to view transcript)') &&
    renderedSingleCommand.endsWith('    six'),
  'one command uses the Codex expanded head-tail output cell',
);
const renderedPlan = serializeBlock(
  renderHistoryEntry(
    {
      type: 'tool',
      toolCallId: 'plan-1',
      toolName: 'update_plan',
      input: {
        explanation: 'Port the reference behavior.',
        plan: [
          { step: 'Inspect Codex', status: 'completed' },
          { step: 'Port the renderer', status: 'in_progress' },
          { step: 'Validate in a PTY', status: 'pending' },
        ],
      },
      output: 'Plan updated',
      status: 'completed',
    },
    renderContext,
  ),
).join('\n');
check(
  renderedPlan.includes('• Updated Plan') &&
    renderedPlan.includes('✔ Inspect Codex') &&
    renderedPlan.includes('□ Port the renderer'),
  'update_plan renders the Codex plan checklist cell',
);
equal(
  serializeBlock(
    renderHistoryEntry(
      { type: 'compacted', summary: 'hidden', previousMessageCount: 20, nextMessageCount: 4, automatic: true },
      renderContext,
    ),
  ).join('\n'),
  ' • Context compacted',
  'compaction renders the compact Codex history marker',
);
equal(
  serializeBlock(
    renderHistoryEntry(
      {
        type: 'entry',
        kind: EntryKind.Meta,
        text: 'Model interrupted to submit steer instructions.',
      },
      renderContext,
    ),
  ).join('\n'),
  ' • Model interrupted to submit steer instructions.',
  'steer interruption renders as a Codex info cell',
);
equal(
  serializeBlock(
    renderHistoryEntry(
      {
        type: 'entry',
        kind: EntryKind.Meta,
        text: 'Stopping all background terminals.',
      },
      renderContext,
    ),
  ).join('\n'),
  ' • Stopping all background terminals.',
  'background terminal cleanup renders as a compact info cell',
);
const waitingState = createAgentStore().getState();
waitingState.busy = true;
waitingState.backgroundWaitCommand = 'npm test';
const renderedWaiting = serializeBlock(
  renderStatusIndicator(waitingState, 460_000, 1, Date.now()),
).join('\n');
check(
  renderedWaiting.includes('Waiting for background terminal (7m 40s • esc to interrupt)') &&
    renderedWaiting.includes('1 background terminal running · /ps to view · /stop to close') &&
    renderedWaiting.includes('↳ npm test'),
  'background polling uses the Codex waiting header, process count, and command detail',
);
const renderedPatch = serializeBlock(
  renderHistoryEntry(
    {
      type: 'tool',
      toolCallId: 'patch-1',
      toolName: 'apply_patch',
      input: {},
      output: 'done',
      status: 'completed',
      fileChanges: [{
        path: 'src/example.ts',
        diff: '--- a/src/example.ts\n+++ b/src/example.ts\n@@ -10,1 +10,2 @@\n old\n+new',
        stats: { added: 1, modified: 0, removed: 0 },
        changeKind: 'modified',
        hasChanges: true,
      }],
    },
    renderContext,
  ),
).join('\n');
check(
  renderedPatch.includes('• Edited src/example.ts (+1 -0)') && renderedPatch.includes('11 +new'),
  'apply_patch renders the Codex edit summary and numbered diff gutter',
);
const renderedMultiFilePatch = serializeBlock(
  renderHistoryEntry(
    {
      type: 'tool',
      toolCallId: 'patch-2',
      toolName: 'apply_patch',
      input: {},
      output: 'done',
      status: 'completed',
      fileChanges: [
        {
          path: 'b.txt',
          diff: '--- a/b.txt\n+++ b/b.txt\n@@ -1,0 +1,1 @@\n+new',
          stats: { added: 1, modified: 0, removed: 0 },
          changeKind: 'modified',
          hasChanges: true,
        },
        {
          path: 'a.txt',
          diff: '--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-one\n+one changed',
          stats: { added: 0, modified: 1, removed: 0 },
          changeKind: 'modified',
          hasChanges: true,
        },
      ],
    },
    renderContext,
  ),
)
  .map(renderedLine => renderedLine.trimEnd())
  .join('\n');
equal(
  renderedMultiFilePatch,
  [
    ' • Edited 2 files (+2 -1)',
    '   └ a.txt (+1 -1)',
    '     1 -one',
    '     1 +one changed',
    '',
    '   └ b.txt (+1 -0)',
    '     1 +new',
  ].join('\n'),
  'apply_patch matches the Codex multi-file summary, sorting, indentation, and diff rows',
);
const renderedWait = serializeBlock(
  renderCommandActivity(
    [
      {
        type: 'tool',
        toolCallId: 'wait-1',
        toolName: 'write_stdin',
        input: { session_id: 7 },
        output: JSON.stringify({ output: 'done', exit_code: 0 }),
        status: 'completed',
        title: 'printf ready; sleep 10',
      },
    ],
    renderContext,
  ),
).join('\n');
equal(
  renderedWait,
  ' • Waited for background terminal · printf ready; sleep 10',
  'background polling uses the Codex waited-for-terminal history cell',
);
const renderedTranscript = serializeBlock(
  renderTranscriptOverlay(commandHistory, { reasoning: '', assistant: '' }, 0, renderContext).block,
).join('\n');
check(
  renderedTranscript.startsWith('/ T R A N S C R I P T / /') &&
    renderedTranscript.includes(' $ printf first\n first\n ✓') &&
    renderedTranscript.includes(' $ printf second\n second\n ✓') &&
    renderedTranscript.includes('q to quit   esc to edit prev'),
  'ctrl+t transcript shows full command output in the Codex pager layout',
);
const assistantMarkdown = serializeBlock(
  renderHistoryEntry(
    { type: 'entry', kind: EntryKind.Assistant, text: '**Implemented.** `ready`' },
    renderContext,
  ),
).join('\n');
equal(
  assistantMarkdown,
  ' • Implemented. ready',
  'assistant Markdown uses the Codex response bullet and indentation',
);
