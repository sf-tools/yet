import { handleCliArgs } from '@/cli';

const cli = handleCliArgs();
if (cli.kind === 'exit') process.exit(cli.code);
if (cli.kind === 'agents-daemon') {
  const { runAgentsDaemon } = await import('@/agent/daemon/server');
  await runAgentsDaemon();
  await new Promise<never>(() => {});
} else if (cli.kind === 'agents') {
  const { runAgentsDashboard } = await import('@/agent/daemon/dashboard');
  await runAgentsDashboard();
  process.exit(0);
}

if (cli.kind !== 'start') process.exit(0);

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  process.stderr.write('Yet requires an interactive terminal.\n');
  process.exit(1);
}

let resumeId: string | undefined;
let initialComposer: string | undefined;
if (cli.resume) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write("'yet resume' requires an interactive terminal.\n");
    process.exit(1);
  }

  const { listYetSessions, resolveYetSessionReference } = await import('@/agent/session-storage');
  if (cli.resume.reference) {
    const selection = await resolveYetSessionReference(cli.resume.reference);
    if (!selection) {
      process.stderr.write(`No saved session found matching '${cli.resume.reference}'.\n`);
      process.exit(1);
    }
    resumeId = selection.sessionId;
  } else {
    const sessions = await listYetSessions({
      ...(cli.resume.showAll ? {} : { cwd: process.cwd() }),
    });
    if (cli.resume.last) {
      if (!sessions[0]) {
        process.stderr.write('No saved sessions found.\n');
        process.exit(1);
      }
      resumeId = sessions[0].sessionId;
    } else {
      initialComposer = '/resume';
    }
  }
}

const { hydrateStateFromSession, loadYetSession } = await import(
  '@/agent/session-storage'
);
const resumeSession = resumeId ? await loadYetSession(resumeId) : null;
if (resumeId && !resumeSession) {
  process.stderr.write(`No saved session found for id '${resumeId}'.\n`);
  process.exit(1);
}

const initialState = resumeSession ? hydrateStateFromSession(resumeSession) : undefined;
const { startEarlyStdinCapture } = await import('@/agent/early-stdin');
startEarlyStdinCapture();
const { AgentApp } = await import('@/agent/app');

const app = new AgentApp({
  initialState,
  initialPrompt: cli.prompt,
  initialComposer,
  resumeSessionScope: cli.resume?.showAll ? 'all' : 'current',
  sessionId: resumeSession?.sessionId,
  threadTitle: resumeSession?.name,
  rolloutPath: resumeSession?.rolloutPath,
  sessionCreatedAt: resumeSession?.createdAt,
  parentSessionId: resumeSession?.parentSessionId,
  forkPoint: resumeSession?.forkPoint,
  model: cli.model,
  thinkingMode: cli.thinkingMode,
  permissionMode: cli.permissionMode,
});

process.on('SIGINT', () => app.cleanup(0));
process.on('uncaughtException', error => app.handleFatalError(error));
process.on('unhandledRejection', error => app.handleFatalError(error));

app.start().catch(error => app.handleFatalError(error));
