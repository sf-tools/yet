import {
  createProvisionalThreadTitle,
  createThreadTitlePrompt,
  parseGeneratedThreadTitle,
  startBackgroundThreadTitle,
  THREAD_TITLE_MAX_CHARS,
  THREAD_TITLE_MODEL,
  THREAD_TITLE_PROMPT_MAX_BYTES,
} from '@/agent/thread-title';
import { check, equal } from './harness';

equal(
  createProvisionalThreadTitle('  fix   the\nUnicode 🧪 persistence writer and more  '),
  'fix the Unicode 🧪 persistence writer',
  'provisional title is immediate, normalized, Unicode-safe, and bounded',
);
equal(THREAD_TITLE_MODEL, 'gpt-5.6-luna', 'background titles use the dedicated Luna model');
equal(THREAD_TITLE_MAX_CHARS, 36, 'thread titles use the Codex display limit');
equal(THREAD_TITLE_PROMPT_MAX_BYTES, 960, 'thread title prompts use the Codex byte limit');
check(
  Buffer.byteLength(createThreadTitlePrompt('🧪'.repeat(1_000))) <= 960,
  'title prompt respects its UTF-8 byte budget',
);
equal(
  parseGeneratedThreadTitle('{"title":"  Fix rollout recovery!  "}'),
  'Fix rollout recovery',
  'structured title output is normalized',
);
equal(parseGeneratedThreadTitle('<title>wrong shape</title>'), null, 'non-JSON title output is rejected');
equal(
  parseGeneratedThreadTitle('{"title":"Valid shape","extra":true}'),
  null,
  'structured title output rejects unknown fields',
);

const neverResolvingSignal: { value: AbortSignal | null } = { value: null };
const neverResolvingTitle = startBackgroundThreadTitle({
  userMessage: 'test shutdown',
  expectedTitle: 'test shutdown',
  getCurrentTitle: () => 'test shutdown',
  applyTitle: () => {
    throw new Error('a never-resolving title should not apply');
  },
  generate: (_message, signal) => {
    neverResolvingSignal.value = signal;
    return new Promise(() => {});
  },
});
check(neverResolvingSignal.value !== null, 'background title generation starts without awaiting a result');
neverResolvingTitle.cancel();
check(neverResolvingSignal.value.aborted, 'background title generation can be abandoned during shutdown');

let resolveLateTitle!: (title: string | null) => void;
let currentTitle = 'provisional title';
const lateTitle = startBackgroundThreadTitle({
  userMessage: 'provisional title',
  expectedTitle: 'provisional title',
  getCurrentTitle: () => currentTitle,
  applyTitle: title => {
    currentTitle = title;
  },
  generate: () => new Promise(resolve => {
    resolveLateTitle = resolve;
  }),
});
currentTitle = 'Manual rename';
resolveLateTitle('Generated title');
await Promise.resolve();
await Promise.resolve();
equal(currentTitle, 'Manual rename', 'manual rename wins over a late generated title');
lateTitle.cancel();

let resolveExpectedTitle!: (title: string | null) => void;
currentTitle = 'expected provisional';
startBackgroundThreadTitle({
  userMessage: 'expected provisional',
  expectedTitle: 'expected provisional',
  getCurrentTitle: () => currentTitle,
  applyTitle: title => {
    currentTitle = title;
  },
  generate: () => new Promise(resolve => {
    resolveExpectedTitle = resolve;
  }),
});
resolveExpectedTitle('Generated replacement');
await Promise.resolve();
await Promise.resolve();
equal(currentTitle, 'Generated replacement', 'generated title replaces only its expected provisional title');

currentTitle = 'failure fallback';
startBackgroundThreadTitle({
  userMessage: 'failure fallback',
  expectedTitle: 'failure fallback',
  getCurrentTitle: () => currentTitle,
  applyTitle: title => {
    currentTitle = title;
  },
  generate: async () => {
    throw new Error('title service unavailable');
  },
});
await Promise.resolve();
await Promise.resolve();
equal(currentTitle, 'failure fallback', 'failed title generation leaves the provisional title');
