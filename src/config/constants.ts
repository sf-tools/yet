import { BUILD_DATE_ISO, BUILD_UNIX_TIME, BUILD_VERSION } from './version';
import { DEFAULT_MODEL, getOpenAIContextWindow } from './models';

const APP_SLOGANS = [
  'Your next move',
  'Plot twist pending',
  'Small chaos, big momentum',
  'Mischief, but productive',
  'Follow the glittering hunch',
  'A whimsical shove forward',
  'Mildly unhinged progress',
  'Professional sparkle engine',
  'Calm hands, tiny gremlin energy',
  'Tasteful chaos coordinator',
  'A pocketful of good ideas',
  'Useful magic, no cape required',
  'Competence with a twinkle',
  'Quietly brewing a clever plan',
  'A gentle nudge toward brilliance',
  'Serious tools, unserious delight',
  'Crisp execution, light mischief',
  'Like a to-do list with good posture',
  'Polite goblin mode engaged',
  'A little sparkle in the workflow',
  'Good instincts, excellent vibes',
  'Neat work with a crooked grin',
  'The friendly hum of momentum',
  'Useful, playful, slightly enchanted',
  'Orderly progress, artful nonsense',
  'Brainstorms with indoor shoes on',
  'Carefully applied whimsy',
  'A bright idea wearing sneakers',
  'Low drama, high delight',
  'Built for focus and side quests',
  'Subtle magic for stubborn problems',
  'Good clean fun, surprisingly effective',
  'A clever little shove',
  'Graceful chaos, shipped on time',
  'Thinking cap with a feather in it',
  'A lantern for the interesting path',
  'Softly dramatic, wildly useful',
  'Precision, but make it charming',
  'Like luck, but reproducible',
  'Tiny fanfare for each next step',
] as const;

export const APP_SLOGAN = APP_SLOGANS[Math.floor(Math.random() * APP_SLOGANS.length)];
export const APP_NAME = `Yet · ${APP_SLOGAN}`;
export const MODEL = DEFAULT_MODEL;

export const APP_VERSION = BUILD_VERSION;
export const APP_RELEASE_UNIX_TIME = BUILD_UNIX_TIME;
export const APP_RELEASE_DATE_ISO = BUILD_DATE_ISO;
export const USER_SHELL = process.env.SHELL || '/bin/sh';

// TODO: dont fallback when no window. throw error instead
export const CONTEXT_WINDOW = getOpenAIContextWindow(MODEL) ?? 1_000_000;

export const COMPACTION_TRIGGER_RATIO = 0.9;
export const COMPACTION_RECENT_MESSAGE_COUNT = 6;
export const COMPACTION_TRIGGER_TOKENS = Math.floor(CONTEXT_WINDOW * COMPACTION_TRIGGER_RATIO);

export function getContextWindow(model: string) {
  return getOpenAIContextWindow(model) ?? CONTEXT_WINDOW;
}

export function getCompactionTriggerTokens(model: string) {
  return Math.floor(getContextWindow(model) * COMPACTION_TRIGGER_RATIO);
}
