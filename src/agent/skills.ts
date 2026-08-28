import { readdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { parse } from 'yaml';

import type { AgentMessage } from './messages';
import type { AgentStore } from '@/store';

const MAX_SKILL_NAME_LENGTH = 64;

type SkillFrontmatter = {
  name?: unknown;
  description?: unknown;
  metadata?: {
    'short-description'?: unknown;
  };
};

type SkillAgentMetadata = {
  interface?: {
    display_name?: unknown;
    short_description?: unknown;
  };
  policy?: {
    allow_implicit_invocation?: unknown;
  };
};

export type SkillMetadata = {
  name: string;
  displayName: string;
  description: string;
  shortDescription: string | null;
  path: string;
  allowImplicitInvocation: boolean;
};

export type SkillSuggestion = {
  kind: 'skill';
  label: string;
  detail: string;
  category: 'Skill';
  name: string;
  path: string;
};

export const YET_SKILLS_ROOT = join(homedir(), '.yet', 'skills');

function sanitizeSingleLine(value: unknown) {
  return typeof value === 'string' ? value.split(/\s+/).filter(Boolean).join(' ') : '';
}

function parseSkill(path: string): SkillMetadata | null {
  let contents: string;
  try {
    contents = readFileSync(path, 'utf8');
  } catch {
    return null;
  }

  const frontmatterMatch = contents.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\s*\r?\n|$)/);
  if (!frontmatterMatch) return null;

  let frontmatter: SkillFrontmatter;
  try {
    frontmatter = parse(frontmatterMatch[1]) as SkillFrontmatter;
  } catch {
    return null;
  }

  const name = sanitizeSingleLine(frontmatter?.name) || basename(dirname(path));
  const description = sanitizeSingleLine(frontmatter?.description);
  if (!name || Array.from(name).length > MAX_SKILL_NAME_LENGTH || !description) return null;

  let agentMetadata: SkillAgentMetadata = {};
  try {
    agentMetadata = parse(readFileSync(join(dirname(path), 'agents', 'openai.yaml'), 'utf8')) as SkillAgentMetadata;
  } catch {}

  const displayName = sanitizeSingleLine(agentMetadata?.interface?.display_name) || name;
  const shortDescription =
    sanitizeSingleLine(agentMetadata?.interface?.short_description) ||
    sanitizeSingleLine(frontmatter?.metadata?.['short-description']) ||
    null;

  return {
    name,
    displayName,
    description,
    shortDescription,
    path,
    allowImplicitInvocation: agentMetadata?.policy?.allow_implicit_invocation !== false,
  };
}

export function discoverSkills(root = YET_SKILLS_ROOT) {
  const skills: SkillMetadata[] = [];

  const visit = (directory: string) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }

    const skillFile = entries.find(entry => entry.isFile() && entry.name === 'SKILL.md');
    if (skillFile) {
      const skill = parseSkill(join(directory, skillFile.name));
      if (skill) skills.push(skill);
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) visit(join(directory, entry.name));
    }
  };

  visit(root);
  return skills.sort((left, right) =>
    left.displayName.localeCompare(right.displayName) || left.path.localeCompare(right.path),
  );
}

function currentSkillMatch(inputChars: string[], cursor: number) {
  const beforeCursor = inputChars.slice(0, cursor).join('');
  return beforeCursor.match(/(?:^|\s)\$([^\s]*)$/);
}

export function currentSkillQuery(inputChars: string[], cursor: number) {
  return currentSkillMatch(inputChars, cursor)?.[1] ?? null;
}

function fuzzyScore(value: string, query: string) {
  const candidate = value.toLocaleLowerCase();
  const needle = query.toLocaleLowerCase();
  if (!needle) return 0;
  if (candidate.startsWith(needle)) return 1;

  const containedAt = candidate.indexOf(needle);
  if (containedAt >= 0) return 10 + containedAt;

  let candidateIndex = 0;
  let gap = 0;
  for (const character of needle) {
    const nextIndex = candidate.indexOf(character, candidateIndex);
    if (nextIndex === -1) return null;
    gap += nextIndex - candidateIndex;
    candidateIndex = nextIndex + 1;
  }
  return 100 + gap;
}

export function listSkillSuggestions(
  inputChars: string[],
  cursor: number,
  skills: SkillMetadata[],
): SkillSuggestion[] {
  const query = currentSkillQuery(inputChars, cursor);
  if (query === null) return [];

  return skills
    .flatMap(skill => {
      const displayScore = fuzzyScore(skill.displayName, query);
      const nameScore = fuzzyScore(skill.name, query);
      const score = Math.min(displayScore ?? Number.POSITIVE_INFINITY, nameScore ?? Number.POSITIVE_INFINITY);
      return Number.isFinite(score) ? [{ skill, score }] : [];
    })
    .sort((left, right) =>
      left.score - right.score || left.skill.displayName.localeCompare(right.skill.displayName),
    )
    .slice(0, 10)
    .map(({ skill }) => ({
      kind: 'skill',
      label: skill.displayName,
      detail: skill.shortDescription ?? skill.description,
      category: 'Skill',
      name: skill.name,
      path: skill.path,
    }));
}

export function acceptSkillSuggestion(store: AgentStore, suggestion: SkillSuggestion) {
  const state = store.getState();
  const match = currentSkillMatch(state.inputChars, state.cursor);
  if (!match) return false;

  const beforeCursor = state.inputChars.slice(0, state.cursor).join('');
  const afterCursor = state.inputChars.slice(state.cursor).join('');
  const fullMatch = match[0];
  const leadingWhitespace = /^\s/.test(fullMatch) ? fullMatch[0] : '';
  const replacement = `${leadingWhitespace}$${suggestion.name} `;
  const replacementStart = beforeCursor.length - fullMatch.length;
  const next = `${beforeCursor.slice(0, replacementStart)}${replacement}${afterCursor}`;

  store.replaceInput(next, replacementStart + replacement.length);
  return true;
}

function isMentionBoundary(character: string | undefined) {
  return character === undefined || /[\s([{]/.test(character);
}

function isMentionEnd(character: string | undefined) {
  return character === undefined || !/[\p{L}\p{N}_-]/u.test(character);
}

export function selectedSkills(text: string, skills: SkillMetadata[]) {
  const matches: Array<{ index: number; skill: SkillMetadata }> = [];

  for (const skill of skills) {
    const mention = `$${skill.name}`;
    let fromIndex = 0;

    while (fromIndex < text.length) {
      const index = text.indexOf(mention, fromIndex);
      if (index === -1) break;

      const before = index === 0 ? undefined : text[index - 1];
      const after = text[index + mention.length];
      if (isMentionBoundary(before) && isMentionEnd(after)) matches.push({ index, skill });
      fromIndex = index + mention.length;
    }
  }

  matches.sort((left, right) => left.index - right.index || right.skill.name.length - left.skill.name.length);
  const seen = new Set<string>();
  const selectedPositions = new Set<number>();
  return matches.flatMap(({ index, skill }) => {
    if (selectedPositions.has(index) || seen.has(skill.path)) return [];
    selectedPositions.add(index);
    seen.add(skill.path);
    return [skill];
  });
}

function escapeXml(value: string) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export async function loadSkillInstructionMessages(skills: SkillMetadata[]) {
  const messages: AgentMessage[] = [];
  const warnings: string[] = [];

  for (const skill of skills) {
    try {
      const contents = await readFile(skill.path, 'utf8');
      messages.push({
        role: 'user',
        content: [
          '<skill>',
          `<name>${escapeXml(skill.name)}</name>`,
          `<path>${escapeXml(skill.path)}</path>`,
          contents,
          '</skill>',
        ].join('\n'),
      });
    } catch (error) {
      warnings.push(
        `Failed to load skill ${skill.name} at ${skill.path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return { messages, warnings };
}

export function renderSkillsCatalog(skills: SkillMetadata[]) {
  if (skills.length === 0) return '';

  const entries = skills.map(skill => {
    const invocationPolicy = skill.allowImplicitInvocation
      ? ''
      : ' Use only when the user explicitly invokes this skill.';
    return `- $${skill.name}: ${skill.description}${invocationPolicy} (${skill.path})`;
  });

  return [
    '<skills_instructions>',
    'Skills are reusable instruction packages stored under ~/.yet/skills.',
    '',
    '### Available skills',
    ...entries,
    '',
    '### How to use skills',
    '- If the user explicitly invokes a skill with `$<name>`, its complete SKILL.md is attached to that turn. Follow it.',
    '- If an implicitly enabled skill clearly matches the request, read its SKILL.md completely before acting.',
    '- Resolve relative paths in a skill against the directory containing its SKILL.md.',
    '- Load only the referenced resources needed for the current task.',
    '</skills_instructions>',
  ].join('\n');
}
