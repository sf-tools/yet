import {
  listYetSessionSnapshots,
  listYetSessionSnapshotsSync,
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
  return listYetSessionSnapshotsSync({ cwd: process.cwd() }).filter(
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

async function resolveTargetSession(requested: string, currentSessionId: string) {
  const sessions = (await listYetSessionSnapshots({ cwd: process.cwd() })).filter(
    session => session.sessionId !== currentSessionId,
  );
  const exact = sessions.find(session => session.sessionId === requested);
  if (exact) return exact;

  const normalizedRequested = requested.trim().toLowerCase();
  const prefixMatches = sessions.filter(session =>
    session.sessionId.toLowerCase().startsWith(normalizedRequested),
  );

  if (prefixMatches.length === 1) return prefixMatches[0];
  if (prefixMatches.length > 1)
    throw new Error(`multiple saved threads match '${requested}'`);

  throw new Error(`No saved thread found for id '${requested}'.`);
}

export const resumeSlashCommand: SlashCommand = {
  name: 'resume',
  description: 'Resume another saved thread from this workspace.',
  argumentSuggestions: ({ getSessionId }) =>
    listOtherWorkspaceSessions(getSessionId()).map(createSessionSuggestion),
  showArgumentSuggestionsOnExactInvocation: true,
  async execute({ getSessionId, openCommandArgumentPicker, switchToSession }, args) {
    if (args.argv.length > 1) throw new Error(`/${args.invocation} accepts at most one argument`);

    const requested = args.argv[0];
    if (!requested) {
      if (listOtherWorkspaceSessions(getSessionId()).length === 0) {
        throw new Error('no other saved threads found for this workspace');
      }
      openCommandArgumentPicker('resume');
      return;
    }

    const target = await resolveTargetSession(requested, getSessionId());
    await switchToSession(target.sessionId);
  },
};
