import {
  listYetSessionsSync,
  resolveYetSessionReference,
  type YetSessionListEntry,
} from '@/agent/session-storage';
import type { SlashCommand, SlashCommandArgumentSuggestion } from '../types';

function formatRelativeAge(isoTime: string) {
  const timestamp = Date.parse(isoTime);
  if (!Number.isFinite(timestamp)) return 'unknown';

  const ageSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1_000));
  if (ageSeconds < 60) return `${ageSeconds}s ago`;
  if (ageSeconds < 60 * 60) return `${Math.floor(ageSeconds / 60)}m ago`;
  if (ageSeconds < 60 * 60 * 24) return `${Math.floor(ageSeconds / (60 * 60))}h ago`;
  if (ageSeconds < 60 * 60 * 24 * 30) return `${Math.floor(ageSeconds / (60 * 60 * 24))}d ago`;
  if (ageSeconds < 60 * 60 * 24 * 365)
    return `${Math.floor(ageSeconds / (60 * 60 * 24 * 30))}mo ago`;
  return `${Math.floor(ageSeconds / (60 * 60 * 24 * 365))}y ago`;
}

function normalizeText(text: string | undefined, fallback: string) {
  return text?.replace(/\s+/g, ' ').trim() || fallback;
}

function listOtherWorkspaceSessions(currentSessionId: string) {
  return listYetSessionsSync({ cwd: process.cwd() }).filter(
    session => session.sessionId !== currentSessionId,
  );
}

function createSessionSuggestion(
  session: YetSessionListEntry,
): SlashCommandArgumentSuggestion & { value: string } {
  return {
    value: session.sessionId,
    label: normalizeText(session.title, 'Untitled thread'),
    suffix: ` ${formatRelativeAge(session.savedAt)}`,
    detail: `${session.sessionId.slice(0, 8)} · ${normalizeText(session.preview, 'No messages yet')}`,
  };
}

export const resumeSlashCommand: SlashCommand = {
  name: 'resume',
  description: 'Resume another saved session.',
  showBusyIndicator: false,
  argumentSuggestions: ({ getSessionId }) =>
    listOtherWorkspaceSessions(getSessionId()).map(createSessionSuggestion),
  async execute({ getSessionId, openResumePicker, switchToSession }, args) {
    if (args.argv.length > 1) throw new Error(`/${args.invocation} accepts at most one argument`);

    const requested = args.argv[0];
    if (!requested) {
      await openResumePicker();
      return;
    }

    const target = await resolveYetSessionReference(requested);
    if (!target) throw new Error(`No saved session found matching '${requested}'.`);
    if (target.sessionId === getSessionId()) throw new Error('that session is already open');
    await switchToSession(target.sessionId);
  },
};
