import { AgentControl } from '@/agent/collaboration/control';
import { AgentExecutionLimiter } from '@/agent/collaboration/execution-limiter';
import { AgentGraphStore, restoreAgentGraph } from '@/agent/collaboration/graph-store';
import { childAgentPath, normalizeAgentPath, resolveAgentPath } from '@/agent/collaboration/agent-path';
import { forkAgentMessages, parseForkTurns, validateSpawnOverrides } from '@/agent/collaboration/fork-history';
import { AgentMailbox, formatMailboxEnvelope } from '@/agent/collaboration/mailbox';
import type { AgentRuntimeHandle, RegisteredAgent } from '@/agent/collaboration/registry';
import { createCollaborationTools, SPAWN_AGENT_DESCRIPTION } from '@/tools/collaboration';
import { serializeOpenAIResponseTools } from '@/providers/openai';
import { createInitialState } from '@/store';
import type { AgentMessage } from '@/agent/messages';
import { deepEqual, equal, rejects, check } from './harness';
import { collaborationV2Fixture as fixture } from './fixtures/collaboration-v2';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentDaemonClient, listSharedAgents, sendSharedAgentCommand } from '@/agent/daemon/client';
import { runAgentsDaemon } from '@/agent/daemon/server';

class FakeRuntime implements AgentRuntimeHandle {
  busy = false;
  starts: string[] = [];
  interrupted = 0;
  disposed = 0;
  readonly state = createInitialState();

  async start(message?: string) {
    if (message) this.starts.push(message);
  }
  async interrupt() { this.interrupted += 1; }
  async dispose() { this.disposed += 1; }
  isBusy() { return this.busy; }
  getState() { return this.state; }
  getHistoryRevision() { return 0; }
}

function config() {
  return {
    model: 'gpt-5.6-sol',
    thinkingMode: 'xhigh' as const,
    fastModeEnabled: false,
    permissionMode: 'ask' as const,
    planningMode: false,
    cwd: process.cwd(),
  };
}

function createControl() {
  const runtimes = new Map<string, FakeRuntime>();
  const events: unknown[] = [];
  const control = new AgentControl({
    maxConcurrency: 4,
    maxResidents: 4,
    runtimeFactory: async ({ agent }) => {
      const runtime = new FakeRuntime();
      runtimes.set(agent.id, runtime);
      return runtime;
    },
    persist: event => { events.push(event); },
  });
  const rootRuntime = new FakeRuntime();
  control.registerRoot({ id: 'root-session', config: config(), runtime: rootRuntime });
  runtimes.set('root-session', rootRuntime);
  return { control, runtimes, events, rootRuntime };
}

const contractControl = createControl().control;
const contractTools = createCollaborationTools({
  agentId: 'root-session',
  agentPath: '/root',
  control: contractControl,
});
deepEqual(
  contractTools.map(tool => ({
    name: tool.name,
    required: (tool.inputSchema.required as string[] | undefined) ?? [],
    outputRequired: (tool.outputSchema?.required as string[] | undefined) ?? [],
  })),
  fixture.tools,
  'collaboration tool schemas match the frozen V2 fixture',
);
check(contractTools.every(tool => tool.namespace === fixture.namespace), 'all collaboration tools use the native namespace');
check(contractTools.every(tool => tool.namespaceDescription === fixture.namespaceDescription), 'collaboration namespace copy matches the fixture');
check(
  !SPAWN_AGENT_DESCRIPTION.includes('Spawned agents inherit your current model by default.'),
  'spawn_agent hides inherited-model metadata in the configured V2 contract',
);
check(
  SPAWN_AGENT_DESCRIPTION.includes('Reasoning efforts: low (default), medium, high, xhigh, max, ultra. Service tiers: priority.'),
  'spawn_agent uses the configured Codex model metadata',
);
const serializedCollaboration = serializeOpenAIResponseTools(contractTools);
equal(serializedCollaboration.length, 1, 'collaboration functions serialize as one native namespace');
const wireNamespace = serializedCollaboration[0];
check(wireNamespace?.type === 'namespace', 'collaboration wire tool is a namespace');
const wireFunctions = wireNamespace.tools.filter(tool => tool.type === 'function') as Array<{
  name: string;
  parameters?: unknown;
  output_schema?: Record<string, unknown> | null;
}>;
deepEqual(
  wireFunctions.map(tool => ({
    name: tool.name,
    parameters: tool.parameters,
    output_schema: tool.output_schema,
  })),
  contractTools.map(tool => ({
    name: tool.name,
    parameters: tool.inputSchema,
    output_schema: tool.outputSchema,
  })),
  'collaboration input and output schemas survive OpenAI wire serialization',
);
const spawnWire = wireFunctions.find(tool => tool.name === 'spawn_agent');
const sendWire = wireFunctions.find(tool => tool.name === 'send_message');
const followupWire = wireFunctions.find(tool => tool.name === 'followup_task');
equal(
  ((spawnWire?.parameters as { properties?: { message?: { encrypted?: boolean } } })
    .properties?.message?.encrypted),
  true,
  'spawn_agent marks its message as an encrypted parameter',
);
equal(
  ((sendWire?.parameters as { properties?: { message?: { encrypted?: boolean } } })
    .properties?.message?.encrypted),
  true,
  'send_message marks its message as an encrypted parameter',
);
equal(
  ((followupWire?.parameters as { properties?: { message?: { encrypted?: boolean } } })
    .properties?.message?.encrypted),
  true,
  'followup_task marks its message as an encrypted parameter',
);

equal(normalizeAgentPath('/root/a/b'), '/root/a/b', 'canonical paths are normalized');
equal(childAgentPath('/root/a', 'b_2'), '/root/a/b_2', 'child paths nest beneath the caller');
equal(resolveAgentPath('/root/a', 'b'), '/root/a/b', 'relative targets resolve beneath the caller');
await rejects(Promise.resolve().then(() => childAgentPath('/root', 'Not Valid')), /lowercase letters/, 'invalid task names are rejected');

equal(parseForkTurns(undefined), 'all', 'fork_turns defaults to all');
equal(parseForkTurns('none'), 'none', 'fork_turns accepts none');
equal(parseForkTurns('3'), 3, 'fork_turns accepts a positive integer string');
await rejects(Promise.resolve().then(() => parseForkTurns('0')), /positive integer/, 'fork_turns rejects zero');
await rejects(
  Promise.resolve().then(() => validateSpawnOverrides({ forkTurns: 'all', model: 'gpt-5.6-luna' })),
  /full-history forks inherit/,
  'full-history forks reject model overrides',
);

const forkMessages: AgentMessage[] = [
  { role: 'system', content: 'system' },
  { role: 'user', content: 'first' },
  { role: 'assistant', content: 'one' },
  { role: 'user', content: 'Message Type: MESSAGE\nTask name: /root\nSender: /root/a\nPayload:\nhidden' },
  { role: 'user', content: 'second' },
  { role: 'tool-call', callId: 'paired', name: 'x', input: {} },
  { role: 'tool-result', callId: 'paired', output: 'ok' },
  { role: 'tool-call', callId: 'orphan', name: 'x', input: {} },
  { role: 'assistant', content: 'two' },
];
deepEqual(forkAgentMessages(forkMessages, 'none'), [forkMessages[0]], 'empty forks retain only system messages');
const partialFork = forkAgentMessages(forkMessages, 1);
check(partialFork.some(message => message.role === 'user' && message.content === 'second'), 'partial forks include the newest user turn');
check(!partialFork.some(message => message.role === 'tool-call' || message.role === 'tool-result'), 'fork filtering removes all inherited tool calls and results');
check(!forkAgentMessages(forkMessages, 'all').some(message => message.role === 'user' && String(message.content).includes('Payload:\nhidden')), 'fork filtering removes inherited inter-agent envelopes');
const triggerFork = forkAgentMessages([
  { role: 'system', content: 'system' },
  { role: 'user', content: 'old user turn' },
  { role: 'assistant', content: 'old answer', phase: 'final_answer' },
  {
    role: 'user',
    content: 'Message Type: MESSAGE\nTask name: /root/worker\nSender: /root\nPayload:\nfollow up',
    interAgent: { triggerTurn: true },
  },
  { role: 'assistant', content: 'follow-up answer', phase: 'final_answer' },
], 1);
check(
  triggerFork.some(message => message.role === 'assistant' && message.content === 'follow-up answer'),
  'trigger-turn envelopes define partial-fork boundaries before being scrubbed',
);
check(
  !triggerFork.some(message => message.role === 'user'),
  'trigger-turn envelopes never leak into inherited model context',
);

const mailbox = new AgentMailbox();
const envelope = mailbox.enqueue({
  kind: 'MESSAGE', from: '/root/a', to: '/root/b', message: 'hello', triggerTurn: false,
});
equal(
  formatMailboxEnvelope(envelope),
  'Message Type: MESSAGE\nTask name: /root/b\nSender: /root/a\nPayload:\nhello',
  'mailbox envelopes use the exact V2 wire format',
);
const waiting = mailbox.wait(10_000);
deepEqual(await waiting, [envelope], 'mailbox waits return immediately when an update is queued');

const { control, runtimes, events } = createControl();
const spawned = await control.spawnAgent('root-session', { taskName: 'worker', message: 'inspect this' });
equal(spawned.task_name, '/root/worker', 'spawn_agent returns the canonical path');
check(typeof spawned.nickname === 'string' && spawned.nickname.length > 0, 'spawn_agent returns a reserved Codex nickname');
const worker = control.registry.getByPath('/root/worker');
check(worker !== null, 'spawned agent is registered');
check(runtimes.get(worker.id)?.starts[0]?.includes('Message Type: NEW_TASK'), 'spawned agent receives a NEW_TASK turn');
await rejects(
  control.spawnAgent('root-session', { taskName: 'worker', message: 'race' }),
  /already exists/,
  'path reservation prevents duplicate task names',
);

await control.sendMessage('root-session', '/root/worker', 'queued', { triggerTurn: false });
check(worker.mailbox.pending().some(item => item.message === 'queued'), 'send_message queues without starting a turn');
await control.sendMessage('root-session', '/root/worker', 'again', { triggerTurn: true });
check(runtimes.get(worker.id)!.starts.some(value => value.includes('again')), 'followup_task starts an idle child turn');

control.updateStatus(worker.id, 'running');
control.updateStatus(worker.id, { completed: 'done' });
control.updateStatus(worker.id, { completed: 'done' });
equal(
  control.registry.getById('root-session')!.mailbox.pending().filter(item => item.kind === 'FINAL_ANSWER').length,
  1,
  'completion delivery is exact-once per child turn',
);
deepEqual(control.listAgents('root-session').map(agent => agent.agent_name), ['/root', '/root/worker'], 'list_agents preserves stable spawn order');
const previous = await control.interruptAgent('root-session', worker.id);
deepEqual(previous, { previous_status: { completed: 'done' } }, 'interrupt_agent returns the previous status');
check(runtimes.get(worker.id)!.interrupted === 1, 'interrupt_agent aborts the child runtime');
check(events.length > 0, 'agent graph changes are persisted');

const nested = await control.spawnAgent(worker.id, { taskName: 'grandchild', message: 'nested task' });
equal(nested.task_name, '/root/worker/grandchild', 'subagents can spawn canonical nested descendants');

const inheritedConfig = control.registry.getByPath('/root/worker/grandchild')!.config;
equal(inheritedConfig.permissionMode, 'ask', 'nested agents cannot widen the parent permission mode');
control.updateConfiguration('root-session', { ...config(), permissionMode: 'full', planningMode: true });
equal(
  control.registry.getByPath('/root/worker/grandchild')!.config.permissionMode,
  'full',
  'loaded descendants never exceed the root current permission mode',
);
equal(
  control.registry.getByPath('/root/worker/grandchild')!.config.planningMode,
  true,
  'read-only planning restrictions propagate to loaded descendants',
);

const limiter = new AgentExecutionLimiter(3);
const releases = [limiter.acquire(), limiter.acquire(), limiter.acquire()];
await rejects(
  Promise.resolve().then(() => limiter.acquire()),
  /maximum number of active agents reached \(3\)/,
  'four advertised slots enforce at most three simultaneous child turns',
);
releases.forEach(release => release());

let failRuntime = true;
const retryControl = new AgentControl({
  maxConcurrency: 4,
  maxResidents: 4,
  runtimeFactory: async () => {
    if (failRuntime) throw new Error('runtime construction failed');
    return new FakeRuntime();
  },
});
retryControl.registerRoot({ id: 'retry-root', config: config(), runtime: new FakeRuntime() });
await rejects(
  retryControl.spawnAgent('retry-root', { taskName: 'retry', message: 'first attempt' }),
  /runtime construction failed/,
  'failed runtime construction rejects the spawn',
);
failRuntime = false;
equal(
  (await retryControl.spawnAgent('retry-root', { taskName: 'retry', message: 'second attempt' })).task_name,
  '/root/retry',
  'failed spawn reservations are released atomically',
);

const residencyRuntimes = new Map<string, FakeRuntime>();
const residencyControl = new AgentControl({
  maxConcurrency: 4,
  maxResidents: 2,
  runtimeFactory: async ({ agent }) => {
    const runtime = new FakeRuntime();
    residencyRuntimes.set(agent.id, runtime);
    return runtime;
  },
});
residencyControl.registerRoot({ id: 'residency-root', config: config(), runtime: new FakeRuntime() });
await residencyControl.spawnAgent('residency-root', { taskName: 'first', message: 'one' });
const firstResident = residencyControl.registry.getByPath('/root/first')!;
residencyControl.takeMailbox(firstResident.id);
residencyControl.updateStatus(firstResident.id, { completed: 'one' });
await residencyControl.spawnAgent('residency-root', { taskName: 'second', message: 'two' });
equal(firstResident.runtime, null, 'LRU residency unloads an idle completed agent at capacity');
equal(residencyRuntimes.get(firstResident.id)!.disposed, 1, 'LRU unloading closes the evicted runtime');

const persisted = control.registry.serialize(worker as RegisteredAgent);
check(!('runtime' in persisted), 'persisted graph records never serialize live runtime handles');
const steerWaitControl = createControl().control;
const steerWait = steerWaitControl.waitAgent('root-session', 10_000);
steerWaitControl.notifyUserSteer('root-session');
deepEqual(
  await steerWait,
  { message: 'Wait interrupted by new input.', timed_out: false },
  'new user input wakes wait_agent with the exact steer summary',
);

const graphHome = await mkdtemp(join(tmpdir(), 'yet-agent-graph-'));
const graphStore = new AgentGraphStore('persistent-root', { yetHome: graphHome });
const persistentControl = new AgentControl({
  runtimeFactory: async () => new FakeRuntime(),
  persist: event => graphStore.append(event),
});
persistentControl.registerRoot({ id: 'persistent-root', config: config(), runtime: new FakeRuntime() });
await persistentControl.spawnAgent('persistent-root', { taskName: 'durable', message: 'persist me' });
const durableAgent = persistentControl.registry.getByPath('/root/durable')!;
await persistentControl.sendMessage('persistent-root', durableAgent.id, 'queued across restart', { triggerTurn: false });
persistentControl.updateStatus(durableAgent.id, 'running');
persistentControl.updateStatus(durableAgent.id, { completed: 'durable result' });
await graphStore.flush();
const persistedAgents = await graphStore.load();
const restoredRuntimes = new Map<string, FakeRuntime>();
const restoredControl = new AgentControl({
  runtimeFactory: async ({ agent }) => {
    const runtime = new FakeRuntime();
    restoredRuntimes.set(agent.id, runtime);
    return runtime;
  },
});
restoredControl.registerRoot({ id: 'persistent-root', config: config(), runtime: new FakeRuntime() });
persistedAgents.forEach(agent => restoredControl.restoreAgent(agent));
equal(
  restoredControl.registry.getById('persistent-root')!.mailbox.pending().filter(item => item.kind === 'FINAL_ANSWER').length,
  1,
  'pending completion notifications survive process restart exactly once',
);
const coldDurable = restoredControl.registry.getByPath('/root/durable')!;
equal(coldDurable.runtime, null, 'restored child agents remain cold until selected or messaged');
await restoredControl.activateAgent(coldDurable.id, 'persistent-root');
check(restoredRuntimes.has(coldDurable.id), 'cold child agents lazy-load on activation');
equal(coldDurable.spawnOrder, durableAgent.spawnOrder, 'restart preserves stable spawn order');
await graphStore.archive();
await restoreAgentGraph('persistent-root', graphHome);
check((await new AgentGraphStore('persistent-root', { yetHome: graphHome }).load()).length > 0, 'archived agent graphs restore with their root session');
await rm(graphHome, { recursive: true, force: true });

const daemonHome = await mkdtemp(join(tmpdir(), 'yet-agent-daemon-'));
const daemon = await runAgentsDaemon({ yetHome: daemonHome });
let forwardedMessage = '';
const daemonClient = new AgentDaemonClient({
  rootId: 'daemon-root',
  title: 'Daemon root',
  cwd: process.cwd(),
  updatedAt: new Date().toISOString(),
  agents: [{
    id: 'daemon-root', path: '/root', nickname: null, status: 'running',
    model: 'gpt-5.6-sol', thinkingMode: 'xhigh',
  }],
}, async command => {
  if (command.action === 'dispatch') forwardedMessage = command.message;
}, daemon.socketPath);
await daemonClient.connect();
const liveRoots = await listSharedAgents(daemon.socketPath);
equal(liveRoots[0]?.rootId, 'daemon-root', 'the local IPC daemon lists registered live roots');
await sendSharedAgentCommand({
  action: 'dispatch', rootId: 'daemon-root', agentId: 'daemon-root', message: 'from dashboard',
}, daemon.socketPath);
equal(forwardedMessage, 'from dashboard', 'the local IPC daemon forwards dashboard commands to the owning root');
await Promise.all([daemon.close(), daemon.close()]);
const restartedDaemon = await runAgentsDaemon({ yetHome: daemonHome });
let reconnectedRoots: Awaited<ReturnType<typeof listSharedAgents>> = [];
for (let attempt = 0; attempt < 30 && reconnectedRoots.length === 0; attempt += 1) {
  await new Promise(resolve => setTimeout(resolve, 50));
  reconnectedRoots = await listSharedAgents(restartedDaemon.socketPath).catch(() => []);
}
equal(reconnectedRoots[0]?.rootId, 'daemon-root', 'a live root re-registers after the agents daemon restarts');
daemonClient.close();
await restartedDaemon.close();
await rm(daemonHome, { recursive: true, force: true });
