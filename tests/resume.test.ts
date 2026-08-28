import { filterYetResumeSessions, renderYetResumeSelector } from '@/resume-selector';
import { createTheme } from '@/theme';
import { widthOf } from '@/text';
import { check, equal } from './harness';

const now = new Date().toISOString();
const earlier = new Date(Date.now() - 60_000).toISOString();
const activeSessions = [
  {
    sessionId: 'current-session',
    cwd: '/work/current',
    createdAt: earlier,
    savedAt: earlier,
    title: 'Current session',
    preview: 'current work',
    rolloutPath: '/tmp/current.jsonl',
  },
  {
    sessionId: 'other-session',
    cwd: '/work/current',
    createdAt: earlier,
    savedAt: now,
    title: 'Other session',
    preview: 'continue implementation',
    rolloutPath: '/tmp/other.jsonl',
  },
  {
    sessionId: 'outside-session',
    cwd: '/work/outside',
    createdAt: earlier,
    savedAt: earlier,
    title: 'Outside session',
    preview: 'other folder',
    rolloutPath: '/tmp/outside.jsonl',
  },
];
const archivedSessions = [
  {
    sessionId: 'archived-session',
    cwd: '/work/current',
    createdAt: earlier,
    savedAt: now,
    archivedAt: now,
    title: 'Archived session',
    preview: 'finished work',
    rolloutPath: '/tmp/archived.jsonl',
  },
];
const state = {
  activeSessions,
  archivedSessions,
  workspacePath: '/work/current',
  launchContext: 'in-session' as const,
  currentSessionId: 'current-session',
  query: '',
  status: 'active' as const,
  folder: 'current' as const,
  selectedIndex: 0,
  transcript: null,
};

equal(filterYetResumeSessions(state).length, 1, 'resume defaults to other sessions in the current folder');
state.query = 'implementation';
equal(filterYetResumeSessions(state)[0]?.sessionId, 'other-session', 'resume search matches session previews');
state.query = '';

const rendered = renderYetResumeSelector(state, createTheme(), 80, 24);
const lines = rendered.split('\n');
equal(lines.length, 24, 'resume rendering stays inside the terminal row budget');
check(lines.every(line => widthOf(line) < 80), 'resume rendering stays inside the terminal column budget');
equal(rendered.match(/Type to search sessions/g)?.length, 1, 'resume renders one search surface per frame');
check(!rendered.includes('Sort:') && !rendered.includes('details'), 'resume keeps the Yet picker surface minimal');

const archivedState = { ...state, status: 'archived' as const };
equal(
  filterYetResumeSessions(archivedState)[0]?.sessionId,
  'archived-session',
  'resume can switch to the archived session collection',
);
