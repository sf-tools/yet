import { handleCliArgs } from '@/cli';

const cli = handleCliArgs();
if (cli.kind === 'exit') process.exit(cli.code);

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  process.stderr.write('Yet requires an interactive terminal.\n');
  process.exit(1);
}

let resumeId = cli.resumeId;
if (cli.resumePicker) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write('--resume without an id requires an interactive terminal.\n');
    process.exit(1);
  }

  const { listYetSessions } = await import('@/agent/session-storage');
  const sessions = await listYetSessions({ cwd: process.cwd() });
  if (sessions.length === 0) {
    process.stderr.write('No saved threads found for this workspace.\n');
    process.exit(1);
  }

  const { selectYetResumeSession } = await import('@/resume-selector');
  const selection = await selectYetResumeSession(sessions, { workspacePath: process.cwd() });
  if (!selection) process.exit(0);
  resumeId = selection.sessionId;
}

const { hydrateStateFromSession, loadYetSession } = await import(
  '@/agent/session-storage'
);
const resumeSession = resumeId ? await loadYetSession(resumeId) : null;
if (resumeId && !resumeSession) {
  process.stderr.write(`No saved thread found for id '${resumeId}'.\n`);
  process.exit(1);
}

const initialState = resumeSession ? hydrateStateFromSession(resumeSession) : undefined;
const { startEarlyStdinCapture } = await import('@/agent/early-stdin');
startEarlyStdinCapture();
const { AgentApp } = await import('@/agent/app');

const app = new AgentApp({
  initialState,
  sessionId: resumeSession?.sessionId,
  threadTitle: resumeSession?.name,
  rolloutPath: resumeSession?.rolloutPath,
  sessionCreatedAt: resumeSession?.createdAt,
  model: cli.model,
  thinkingMode: cli.thinkingMode,
  permissionMode: cli.permissionMode,
});

process.on('SIGINT', () => app.cleanup(0));
process.on('uncaughtException', error => app.handleFatalError(error));
process.on('unhandledRejection', error => app.handleFatalError(error));

app.start().catch(error => app.handleFatalError(error));
