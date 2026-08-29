import { AgentApp } from '@/agent/app';
import { getEarlyStdinStream } from '@/agent/early-stdin';
import { readClipboardImage } from '@/agent/clipboard-image';
import { displayImageTokens } from '@/agent/image-tokens';
import { fallbackSearchMentionEntries } from '@/agent/mention-index';
import { mergePromptHistoryEntries, navigatePromptHistory } from '@/agent/prompt-history';
import {
  acceptSkillSuggestion,
  discoverSkills,
  listSkillSuggestions,
  loadSkillInstructionMessages,
  renderSkillsCatalog,
  selectedSkills,
} from '@/agent/skills';
import { OPENAI_MODEL_OPTIONS, getOpenAIProviderModelId } from '@/config';
import { SYSTEM_PROMPT } from '@/config';
import { resolveInputBinding, splitInputEvents } from '@/agent/keybinds';
import { createAgentStore } from '@/store';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, deepEqual, equal, rejects } from './harness';

const modelIds = OPENAI_MODEL_OPTIONS.map(model => model.id);
check(typeof AgentApp === 'function', 'the bundled TUI loads under Ant');
equal(getEarlyStdinStream(), null, 'importing the TUI does not start early stdin capture');
deepEqual(
  modelIds,
  ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-daybreak-blue-latest', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex-spark'],
  'supported model list is exact',
);
equal(getOpenAIProviderModelId('gpt-daybreak-blue-latest'), 'daybreak-blue-latest', 'daybreak model maps to its provider ID');
deepEqual(
  resolveInputBinding('\u001bb'),
  { type: 'cycleAgent', delta: -1, wordMotionFallback: true },
  'option+b cycles to the previous agent only when word motion is available as a fallback',
);
deepEqual(
  resolveInputBinding('\u001bf'),
  { type: 'cycleAgent', delta: 1, wordMotionFallback: true },
  'option+f cycles to the next agent only when word motion is available as a fallback',
);
check(SYSTEM_PROMPT.includes('You are Yet,'), 'the model prompt identifies Yet');
check(
  SYSTEM_PROMPT.includes('made by The San Francisco Tooling Company.'),
  'the model prompt identifies its maker',
);
const antRuntime = (globalThis as typeof globalThis & { Ant?: { version?: string } }).Ant;
if (antRuntime?.version) {
  check(SYSTEM_PROMPT.includes(`Runtime: Ant ${antRuntime.version}`), 'the model prompt uses Ant.version');
} else {
  check(!SYSTEM_PROMPT.includes('Runtime:'), 'the model prompt omits runtime outside Ant');
}
check(!SYSTEM_PROMPT.includes(`[Ant](antjs.org) ${process.version}`), 'the model prompt never labels the Node compatibility version as Ant');

const promptHistory = ['newest prompt', 'middle prompt', 'oldest prompt'];
const newestHistory = navigatePromptHistory(
  promptHistory,
  { index: null, draft: '' },
  'draft text',
  -1,
);
equal(newestHistory?.text, 'newest prompt', 'first Up recalls the newest persisted prompt');
const middleHistory = navigatePromptHistory(promptHistory, newestHistory!, newestHistory!.text, -1);
equal(middleHistory?.text, 'middle prompt', 'a second Up continues through persisted prompt history');
const oldestHistory = navigatePromptHistory(promptHistory, middleHistory!, middleHistory!.text, -1);
equal(oldestHistory?.text, 'oldest prompt', 'Up reaches older prompts after opening a new chat');
const backToMiddleHistory = navigatePromptHistory(
  promptHistory,
  oldestHistory!,
  oldestHistory!.text,
  1,
);
equal(backToMiddleHistory?.text, 'middle prompt', 'Down walks back toward newer prompts');
const backToNewestHistory = navigatePromptHistory(
  promptHistory,
  backToMiddleHistory!,
  backToMiddleHistory!.text,
  1,
);
const restoredDraftHistory = navigatePromptHistory(
  promptHistory,
  backToNewestHistory!,
  backToNewestHistory!.text,
  1,
);
deepEqual(
  restoredDraftHistory,
  { index: null, draft: '', text: 'draft text' },
  'Down after the newest prompt restores the original composer draft',
);
deepEqual(
  mergePromptHistoryEntries(
    [{ text: 'latest local', createdAt: '2026-08-28T12:00:00.000Z' }],
    [
      { text: 'older rollout prompt', createdAt: '2026-08-28T11:00:00.000Z' },
      { text: 'latest local', createdAt: '2026-08-28T10:00:00.000Z' },
    ],
  ).map(entry => entry.text),
  ['latest local', 'older rollout prompt'],
  'prompt history merges the append log with recovered session prompts',
);

deepEqual(resolveInputBinding(Buffer.from([0x16])), { type: 'pasteImage' }, 'ctrl+v requests an image paste');
deepEqual(resolveInputBinding('\u001bv'), { type: 'pasteImage' }, 'alt+v requests an image paste');
deepEqual(
  resolveInputBinding('\u001b[118;5:1u'),
  { type: 'pasteImage' },
  'kitty ctrl+v press requests one image paste',
);
equal(resolveInputBinding('\u001b[118;5:2u'), null, 'kitty ctrl+v repeat does not duplicate the image');
equal(resolveInputBinding('\u001b[118;5:3u'), null, 'kitty ctrl+v release does not duplicate the image');
deepEqual(
  resolveInputBinding(Buffer.from([0x1f])),
  { type: 'toggleSideConversation' },
  'ctrl+/ toggles the side conversation',
);
deepEqual(
  resolveInputBinding('\u001b[47;5u'),
  { type: 'toggleSideConversation' },
  'kitty ctrl+/ toggles the side conversation',
);
deepEqual(
  resolveInputBinding(Buffer.from([0x14])),
  { type: 'toggleTranscript' },
  'ctrl+t opens the full transcript',
);
deepEqual(resolveInputBinding(Buffer.from([0x02])), { type: 'pageTranscript', delta: 1 }, 'ctrl+b pages up in the transcript');
deepEqual(resolveInputBinding(Buffer.from([0x06])), { type: 'pageTranscript', delta: -1 }, 'ctrl+f pages down in the transcript');
deepEqual(resolveInputBinding(Buffer.from([0x15])), { type: 'halfPageTranscript', delta: 1 }, 'ctrl+u moves up half a transcript page');
deepEqual(resolveInputBinding(Buffer.from([0x04])), { type: 'halfPageTranscript', delta: -1 }, 'ctrl+d moves down half a transcript page');
deepEqual(
  splitInputEvents('\u001b[A\u001b[A\u001b[B'),
  { events: ['\u001b[A', '\u001b[A', '\u001b[B'], remainder: '' },
  'coalesced alternate-scroll arrows remain separate input events',
);
deepEqual(
  splitInputEvents('\u001b['),
  { events: [], remainder: '\u001b[' },
  'an incomplete terminal key sequence waits for the next stdin chunk',
);

const clipboardPng = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const pastedClipboardImage = await readClipboardImage({
  hasImage: () => true,
  getImageBinary: async () => clipboardPng,
});
deepEqual(Array.from(pastedClipboardImage.bytes), clipboardPng, 'clipboard PNG bytes are retained');
equal(pastedClipboardImage.mediaType, 'image/png', 'clipboard images use the provider-neutral PNG media type');
await rejects(
  readClipboardImage({
    hasImage: () => false,
    getImageBinary: async () => clipboardPng,
  }),
  /no image on clipboard/,
  'an empty image clipboard reports a clear failure',
);

const imageToken = '[image:12345678]';
equal(
  displayImageTokens(`${imageToken}${imageToken}`),
  '[Image #1][Image #2]',
  'composer image tokens use compact numbered labels',
);
const imageTokenStore = createAgentStore();
imageTokenStore.replaceInput(`${imageToken} tail`, imageToken.length);
imageTokenStore.moveCursor(-1);
equal(imageTokenStore.getState().cursor, 0, 'left arrow moves across an image token atomically');
imageTokenStore.moveCursor(1);
equal(imageTokenStore.getState().cursor, imageToken.length, 'right arrow moves across an image token atomically');
check(imageTokenStore.deleteBackward(), 'backspace deletes an image token');
equal(imageTokenStore.getState().inputChars.join(''), ' tail', 'backspace removes the complete image token');

const fuzzyFileEntries = [
  { kind: 'file' as const, label: 'ant.lockb', name: 'ant.lockb', searchPath: 'ant.lockb' },
  {
    kind: 'file' as const,
    label: 'src/agent/thread-title.ts',
    name: 'thread-title.ts',
    searchPath: 'src/agent/thread-title.ts',
  },
  {
    kind: 'file' as const,
    label: 'src/render/components/transcript.ts',
    name: 'transcript.ts',
    searchPath: 'src/render/components/transcript.ts',
  },
];
deepEqual(
  fallbackSearchMentionEntries(fuzzyFileEntries, '', 10),
  [],
  'an empty @ query does not surface arbitrary files',
);
equal(
  fallbackSearchMentionEntries(fuzzyFileEntries, 'ant', 10)[0]?.label,
  'ant.lockb',
  'file fuzzing ranks a direct basename match first',
);
equal(
  fallbackSearchMentionEntries(fuzzyFileEntries, 'thtit', 10)[0]?.label,
  'src/agent/thread-title.ts',
  'file fuzzing supports non-contiguous path-aware queries',
);

const skillsHome = await mkdtemp(join(tmpdir(), 'yet-skills-'));
try {
  const skillDirectory = join(skillsHome, '.system', 'review-changes');
  await mkdir(join(skillDirectory, 'agents'), { recursive: true });
  await writeFile(
    join(skillDirectory, 'SKILL.md'),
    [
      '---',
      'name: Review Changes',
      'description: Review a code change and report actionable defects.',
      'metadata:',
      '  short-description: Find defects',
      '---',
      '',
      '# Review Changes',
      '',
      'Inspect the full diff before reporting findings.',
      '',
    ].join('\n'),
  );
  await writeFile(
    join(skillDirectory, 'agents', 'openai.yaml'),
    [
      'interface:',
      '  display_name: Review Changes',
      '  short_description: Find actionable bugs',
      'policy:',
      '  allow_implicit_invocation: false',
      '',
    ].join('\n'),
  );

  const skills = discoverSkills(skillsHome);
  equal(skills.length, 1, 'nested Codex-style skill packages are discovered');
  equal(skills[0]?.displayName, 'Review Changes', 'skill interface metadata is loaded');
  equal(skills[0]?.shortDescription, 'Find actionable bugs', 'skill UI description is loaded');
  equal(skills[0]?.allowImplicitInvocation, false, 'skill invocation policy is loaded');

  const skillSuggestions = listSkillSuggestions(Array.from('$rev'), 4, skills);
  equal(skillSuggestions[0]?.label, 'Review Changes', '$ suggestions use the skill display name');
  equal(skillSuggestions[0]?.category, 'Skill', '$ suggestions identify their catalog category');
  const skillStore = createAgentStore();
  skillStore.replaceInput('$rev', 4);
  check(
    skillSuggestions[0] !== undefined && acceptSkillSuggestion(skillStore, skillSuggestions[0]),
    'a skill suggestion can be accepted',
  );
  equal(
    skillStore.getState().inputChars.join(''),
    '$Review Changes ',
    'accepting a skill inserts its full frontmatter name',
  );

  const invokedSkills = selectedSkills('Please $Review Changes, then summarize.', skills);
  equal(invokedSkills[0]?.path, skills[0]?.path, 'skill mentions with spaces select the package');
  const loadedSkill = await loadSkillInstructionMessages(invokedSkills);
  const skillInstruction = loadedSkill.messages[0];
  check(
    skillInstruction?.role === 'user' &&
      typeof skillInstruction.content === 'string' &&
      skillInstruction.content.includes('<name>Review Changes</name>') &&
      skillInstruction.content.includes('Inspect the full diff'),
    'selected skills inject the complete SKILL.md as a user instruction',
  );
  check(
    renderSkillsCatalog(skills).includes('Use only when the user explicitly invokes this skill.'),
    'the model-visible catalog preserves explicit-only skill policy',
  );
} finally {
  await rm(skillsHome, { recursive: true, force: true });
}
