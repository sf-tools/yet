import { AgentApp } from '../src/agent/app';
import { createRenderContext, serializeBlock } from '../src/render';
import { createAgentStore } from '../src/store';
import { createTheme } from '../src/theme';
import { EntryKind } from '../src/types';
import { check } from './harness';

const app = new AgentApp();
const internals = app as unknown as {
  store: ReturnType<typeof createAgentStore>;
  renderPendingHistory(
    ctx: ReturnType<typeof createRenderContext>,
    animatedAssistantIndex: number | null,
  ): ReturnType<typeof import('../src/render/components/entry').renderHistoryEntry>;
  renderTransientLines(
    ctx: ReturnType<typeof createRenderContext>,
    suggestions: [],
  ): string[];
};

internals.store.pushHistoryEntry({
  type: 'tool',
  toolCallId: 'plan-spacing',
  toolName: 'update_plan',
  input: {
    plan: [
      { step: 'Inspect slash commands', status: 'in_progress' },
      { step: 'Implement loop', status: 'pending' },
    ],
  },
  output: 'Plan updated',
  status: 'completed',
});
internals.store.pushHistoryEntry({
  type: 'entry',
  kind: EntryKind.Assistant,
  text: 'I’ll inspect the command architecture.',
});
internals.store.pushHistoryEntry({
  type: 'entry',
  kind: EntryKind.Meta,
  text: '■ Conversation interrupted - tell the model what to do differently',
});

const rendered = serializeBlock(
  internals.renderPendingHistory(
    createRenderContext(createTheme(), false, 100, 40),
    null,
  ),
).join('\n');

check(
  /Updated Plan[\s\S]*Implement loop\n\n • I’ll inspect the command architecture\.\n\n ■ Conversation interrupted/.test(rendered),
  'history cells keep one blank row between plan, assistant, and interruption output',
);

const workingApp = new AgentApp();
const workingInternals = workingApp as unknown as {
  store: ReturnType<typeof createAgentStore>;
  renderTransientLines(
    ctx: ReturnType<typeof createRenderContext>,
    suggestions: [],
  ): string[];
};
workingInternals.store.setBusy(true);
const workingLines = workingInternals.renderTransientLines(
  createRenderContext(createTheme(), false, 100, 40),
  [],
);
const workingIndex = workingLines.findIndex(renderedLine => renderedLine.includes('Working'));
check(workingIndex > 0, 'working status is rendered');
check(workingLines[workingIndex - 1] === '', 'working status has a blank row above it');
check(workingLines[workingIndex + 1] !== '', 'working status has no blank row below it');
check(workingLines[workingIndex + 2]?.includes('Describe a task or ask a question'), 'composer follows the working status immediately');
