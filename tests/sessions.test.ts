import {
  SessionRecorder,
  createTurnContextEvent,
  hydrateStateFromSession,
  listYetSessionPrompts,
  listYetSessions,
  listYetSessionsSync,
  loadYetSession,
  persistedStateFromAgentState,
  readYetRollout,
  restoreYetSession,
} from '@/agent/session-storage';
import { createAgentStore } from '@/store';
import { EntryKind } from '@/types';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, deepEqual, equal, rejects } from './harness';

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

  const historyRecorder = await SessionRecorder.open({
    sessionId: 'prompt-history-session',
    cwd: sessionHome,
    yetHome: sessionHome,
  });
  historyRecorder.record({
    type: 'user_message',
    payload: {
      entries: [{ type: 'entry', kind: EntryKind.User, text: 'older saved prompt' }],
    },
  });
  historyRecorder.record({
    type: 'user_message',
    payload: {
      entries: [{
        type: 'entry',
        kind: EntryKind.User,
        text: '[Image #1]',
        turn: { messageIndex: 1, prompt: 'newer saved prompt with image token' },
      }],
    },
  });
  await historyRecorder.close();
  deepEqual(
    (await listYetSessionPrompts({ cwd: sessionHome, yetHome: sessionHome }))
      .slice(0, 2)
      .map(entry => entry.text),
    ['newer saved prompt with image token', 'older saved prompt'],
    'new chats recover multiple composer prompts from saved sessions in newest-first order',
  );

  const archivedRecorder = await SessionRecorder.open({
    sessionId: 'archived-session',
    cwd: sessionHome,
    yetHome: sessionHome,
  });
  archivedRecorder.record({
    type: 'thread_name_updated',
    payload: { name: 'Archived work', source: 'manual' },
  });
  archivedRecorder.record({
    type: 'transcript_entry',
    payload: { entries: [{ type: 'plain', text: 'archive me' }] },
  });
  const activeArchivePath = archivedRecorder.rolloutPath;
  const archivedPath = await archivedRecorder.archiveSession();
  check(!existsSync(activeArchivePath) && existsSync(archivedPath), 'archiving moves the canonical rollout');
  check(
    !(await listYetSessions({ yetHome: sessionHome })).some(
      entry => entry.sessionId === 'archived-session',
    ),
    'archived sessions leave the active resume list',
  );
  check(
    (await listYetSessions({ yetHome: sessionHome, archived: true })).some(
      entry => entry.sessionId === 'archived-session',
    ),
    'archived sessions appear in the archived resume list',
  );
  equal(
    await loadYetSession('archived-session', { yetHome: sessionHome }),
    null,
    'normal session loading does not reopen archived work',
  );
  await rm(join(sessionHome, 'session_index.jsonl'), { force: true });
  check(
    (await listYetSessions({ yetHome: sessionHome, archived: true })).some(
      entry => entry.sessionId === 'archived-session',
    ),
    'the archived index is rebuilt from canonical JSONL',
  );
  const restoredArchive = await restoreYetSession('archived-session', { yetHome: sessionHome });
  check(restoredArchive !== null && existsSync(restoredArchive.rolloutPath), 'restoring reactivates an archived session');
  check(
    !(await listYetSessions({ yetHome: sessionHome, archived: true })).some(
      entry => entry.sessionId === 'archived-session',
    ),
    'restored sessions leave the archived list',
  );
  const restoredRecorder = await SessionRecorder.open({
    sessionId: restoredArchive.sessionId,
    cwd: restoredArchive.cwd,
    rolloutPath: restoredArchive.rolloutPath,
    createdAt: restoredArchive.createdAt,
    yetHome: sessionHome,
  });
  await restoredRecorder.deleteSession();

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
  contextStore.setGoal({
    objective: 'Keep the event session durable',
    status: 'paused',
    tokenBudget: 80_000,
    tokensUsed: 12_500,
    timeUsedSeconds: 60,
    createdAt: 1,
    updatedAt: 2,
  });
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
        toolName: 'exec_command',
        input: { cmd: 'pwd' },
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
        toolName: 'exec_command',
        input: { cmd: 'pwd' },
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
      sessionUsage: { inputTokens: 8, outputTokens: 3, reasoningTokens: 1, cachedInputTokens: 0 },
    },
  });
  recorder.record({
    type: 'transcript_entry',
    payload: { entries: [{ type: 'plain', text: 'local transcript note' }] },
  });
  recorder.record({
    type: 'usage_updated',
    payload: {
      lastUsage: { inputTokens: 10, outputTokens: 4, reasoningTokens: 2, cachedInputTokens: 1 },
      sessionUsage: { inputTokens: 18, outputTokens: 7, reasoningTokens: 3, cachedInputTokens: 1 },
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
  equal(loaded.state.goal?.objective, 'Keep the event session durable', 'rollout restores durable goal state');
  deepEqual(
    loaded.state.sessionUsage,
    { inputTokens: 18, outputTokens: 7, reasoningTokens: 3, cachedInputTokens: 1 },
    'rollout restores cumulative session token usage',
  );
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
    command: `yet resume ${loaded.sessionId}`,
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
      entry => entry.type === 'resume_hint' && entry.command === `yet resume ${loaded.sessionId}`,
    ),
    'a fork persists the parent resume hint',
  );
  check(
    hydrateStateFromSession(forked).historyEntries.some(
      entry => entry.type === 'resume_hint' && entry.command === `yet resume ${loaded.sessionId}`,
    ),
    'resuming a fork preserves its parent resume hint',
  );
  const legacySwitchState = hydrateStateFromSession({
    ...loaded,
    state: {
      ...loaded.state,
      historyEntries: [
        ...loaded.state.historyEntries,
        { type: 'plain', text: 'Token usage: total=1 input=1 output=0' },
        { type: 'resume_hint', command: 'yet resume previous-session' },
      ],
    },
  });
  check(
    !legacySwitchState.historyEntries.some(entry => entry.type === 'resume_hint'),
    'resuming a root session drops legacy cross-session handoffs',
  );
  check(
    !legacySwitchState.historyEntries.some(
      entry => entry.type === 'plain' && entry.text.startsWith('Token usage: '),
    ),
    'resuming a root session drops token usage attached to a legacy handoff',
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
        toolName: 'exec_command',
        input: { cmd: 'sleep 1' },
        status: 'running',
      },
      message: {
        role: 'tool-call',
        callId: 'interrupted-tool',
        name: 'exec_command',
        input: { cmd: 'sleep 1' },
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
