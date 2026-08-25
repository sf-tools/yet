import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, relative, resolve } from 'node:path';

import { createFileChange, describeFileChange, normalizeLineEndings } from '@/file-changes';
import type { FileChange } from '@/types';
import { isWithinWorkspace } from '@/permissions';
import {
  asObject,
  assertOnlyArguments,
  permissionArgument,
  stringArgument,
  type Tool,
  type ToolFactoryOptions,
} from './types';

type HunkLine = { kind: 'context' | 'add' | 'remove'; text: string };

type Hunk = {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: HunkLine[];
};

type PatchFile = {
  oldPath: string | null;
  newPath: string | null;
  hunks: Hunk[];
};

type PendingFile = {
  path: string;
  displayPath: string;
  previousContent: string | null;
  nextContent: string | null;
  fileChange: FileChange;
};

const FUZZ = 20;

function parsePatch(patch: string): PatchFile[] {
  const lines = normalizeLineEndings(patch).split('\n');
  const files: PatchFile[] = [];
  let current: PatchFile | null = null;
  let i = 0;

  const stripPrefix = (raw: string): string | null => {
    const value = raw.trim();
    if (!value || value === '/dev/null') return null;
    if (value.startsWith('a/') || value.startsWith('b/')) return value.slice(2);
    return value;
  };

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith('--- ')) {
      const oldPath = stripPrefix(line.slice(4));
      const next = lines[i + 1];
      if (!next?.startsWith('+++ '))
        throw new Error(`malformed patch: expected '+++' after '---' at line ${i + 1}`);
      const newPath = stripPrefix(next.slice(4));
      current = { oldPath, newPath, hunks: [] };
      files.push(current);
      i += 2;
      continue;
    }

    if (line.startsWith('@@')) {
      if (!current) throw new Error(`malformed patch: hunk before file header at line ${i + 1}`);
      const header = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (!header) throw new Error(`malformed hunk header at line ${i + 1}: ${line}`);

      const hunk: Hunk = {
        oldStart: Number(header[1]),
        oldCount: header[2] ? Number(header[2]) : 1,
        newStart: Number(header[3]),
        newCount: header[4] ? Number(header[4]) : 1,
        lines: [],
      };

      i += 1;
      let consumedOld = 0;
      let consumedNew = 0;
      while (i < lines.length && (consumedOld < hunk.oldCount || consumedNew < hunk.newCount)) {
        const next = lines[i];
        if (next.startsWith('@@') || next.startsWith('--- ') || next.startsWith('diff ')) break;

        if (next.startsWith('\\')) {
          i += 1;
          continue;
        }

        if (next.startsWith(' ')) {
          hunk.lines.push({ kind: 'context', text: next.slice(1) });
          consumedOld += 1;
          consumedNew += 1;
        } else if (next.startsWith('+')) {
          hunk.lines.push({ kind: 'add', text: next.slice(1) });
          consumedNew += 1;
        } else if (next.startsWith('-')) {
          hunk.lines.push({ kind: 'remove', text: next.slice(1) });
          consumedOld += 1;
        } else if (next === '') {
          break;
        } else {
          break;
        }

        i += 1;
      }

      current.hunks.push(hunk);
      continue;
    }

    i += 1;
  }

  if (files.length === 0) throw new Error('no file headers found in patch');
  return files;
}

function tryApplyAt(source: string[], hunk: Hunk, position: number): string[] | null {
  const consumed: string[] = [];
  for (const line of hunk.lines) {
    if (line.kind === 'add') continue;
    consumed.push(line.text);
  }

  if (position < 0 || position + consumed.length > source.length) return null;
  for (let k = 0; k < consumed.length; k += 1) {
    if (source[position + k] !== consumed[k]) return null;
  }

  const produced: string[] = [];
  for (const line of hunk.lines) {
    if (line.kind === 'remove') continue;
    produced.push(line.text);
  }

  return [...source.slice(0, position), ...produced, ...source.slice(position + consumed.length)];
}

function locateAndApply(source: string[], hunk: Hunk): string[] {
  const baseIndex = Math.max(0, hunk.oldStart - 1);

  const direct = tryApplyAt(source, hunk, baseIndex);
  if (direct) return direct;

  for (let delta = 1; delta <= FUZZ; delta += 1) {
    const before = tryApplyAt(source, hunk, baseIndex - delta);
    if (before) return before;
    const after = tryApplyAt(source, hunk, baseIndex + delta);
    if (after) return after;
  }

  throw new Error(
    `hunk @ -${hunk.oldStart},${hunk.oldCount} could not be located (context mismatch)`,
  );
}

function splitForPatch(content: string | null): string[] {
  if (content === null) return [];
  const normalized = normalizeLineEndings(content);
  const parts = normalized.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

function joinForPatch(lines: string[], originalHadTrailingNewline: boolean): string {
  if (lines.length === 0) return '';
  return originalHadTrailingNewline ? `${lines.join('\n')}\n` : lines.join('\n');
}

async function readMaybe(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT')
      return null;
    throw error;
  }
}

async function canonicalPotentialPath(path: string) {
  let cursor = path;
  const tail: string[] = [];

  while (true) {
    try {
      return resolve(await realpath(cursor), ...tail);
    } catch (error) {
      if (
        !error ||
        typeof error !== 'object' ||
        (error as NodeJS.ErrnoException).code !== 'ENOENT'
      )
        throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      tail.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

async function resolvePatchPath(rawPath: string, workspaceRoot: string, allowOutside: boolean) {
  if (rawPath.includes('\0')) throw new Error('patch path contains a NUL byte');
  const resolvedPath = resolve(workspaceRoot, rawPath);
  if (allowOutside) return resolvedPath;

  const canonical = await canonicalPotentialPath(resolvedPath);
  if (!isWithinWorkspace(canonical, workspaceRoot))
    throw new Error(
      `patch path escapes the workspace: ${rawPath}; request elevated permissions explicitly`,
    );
  return canonical;
}

async function buildPending(
  file: PatchFile,
  workspaceRoot: string,
  allowOutside: boolean,
): Promise<PendingFile> {
  const isCreate = file.oldPath === null && file.newPath !== null;
  const isDelete = file.newPath === null && file.oldPath !== null;
  const targetPath = file.newPath ?? file.oldPath;
  if (!targetPath) throw new Error('patch entry missing both old and new paths');
  if (file.oldPath && file.newPath && file.oldPath !== file.newPath)
    throw new Error('renames are not supported; use a delete and create pair');
  const path = await resolvePatchPath(targetPath, workspaceRoot, allowOutside);

  const previousContent = isCreate ? null : await readMaybe(path);
  if (!isCreate && previousContent === null)
    throw new Error(`cannot patch missing file: ${targetPath}`);
  if (isCreate && (await readMaybe(path)) !== null)
    throw new Error(`cannot create existing file: ${targetPath}`);

  const trailingNewline = previousContent !== null && previousContent.endsWith('\n');
  let working = splitForPatch(previousContent);

  for (const hunk of file.hunks) {
    working = locateAndApply(working, hunk);
  }

  const nextContent = isDelete
    ? null
    : joinForPatch(working, trailingNewline || previousContent === null);
  const displayPath = isWithinWorkspace(path, workspaceRoot)
    ? relative(workspaceRoot, path) || '.'
    : path;
  const fileChange = createFileChange(displayPath, previousContent, nextContent);

  return { path, displayPath, previousContent, nextContent, fileChange };
}

function summarize(pending: PendingFile[]) {
  const parts = pending.map(item => `${item.displayPath} · ${describeFileChange(item.fileChange)}`);
  return parts.join('\n');
}

export function createApplyPatchTool(options: ToolFactoryOptions) {
  return {
    name: 'apply_patch',
    description:
      'Apply a unified diff after validating every file and hunk. Patch must contain `--- a/path` and `+++ b/path` headers per file, plus `@@ -old,n +new,n @@` hunks. Use `/dev/null` for create or delete.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        patch: {
          type: 'string',
          description: 'Unified diff text with file headers and hunks.',
        },
        permissions: {
          type: 'string',
          enum: ['workspace', 'elevated'],
          description: 'Use elevated only for paths outside the workspace.',
        },
        justification: {
          type: 'string',
          description: 'Required explanation when elevated permission is requested.',
        },
      },
      required: ['patch'],
    },
    execute: async (input: unknown) => {
      if (options.getPlanningMode()) throw new Error('apply_patch is unavailable in planning mode');
      const object = asObject(input, 'apply_patch');
      assertOnlyArguments(object, ['patch', 'permissions', 'justification']);
      const patch = stringArgument(object, 'patch');
      const requested = permissionArgument(object);
      const justification =
        typeof object.justification === 'string' ? object.justification.trim() : '';
      if (object.justification !== undefined && typeof object.justification !== 'string')
        throw new Error('justification must be a string');
      if (requested === 'elevated' && !justification)
        throw new Error('justification is required for elevated patch access');

      const files = parsePatch(patch);
      const pending: PendingFile[] = [];
      const workspaceRoot = await realpath(resolve(options.workspaceRoot));
      const allowOutside = options.getPermissionMode() === 'full' || requested === 'elevated';
      for (const file of files)
        pending.push(await buildPending(file, workspaceRoot, allowOutside));
      const uniquePaths = new Set(pending.map(item => item.path));
      if (uniquePaths.size !== pending.length)
        throw new Error('a patch cannot contain the same target path more than once');

      const fileChanges = pending.map(item => item.fileChange);
      const detail = `${pending.length} file${pending.length === 1 ? '' : 's'}`;

      if (
        !(await options.authorize(
          {
            scope: 'edit',
            title: requested === 'elevated' ? 'Edit files outside the workspace' : 'Apply patch',
            detail,
            body: [
              ...(justification ? [justification] : []),
              ...summarize(pending).split('\n'),
            ],
            fileChanges,
          },
          {
            requested,
            potentiallyUnsafe: pending.some(item => item.nextContent === null),
          },
        ))
      ) {
        throw new Error('patch denied by user');
      }

      const mutations: Array<{
        path: string;
        previousContent: string | null;
        nextContent: string | null;
      }> = [];
      for (const item of pending) {
        if (item.nextContent === null) {
          await rm(item.path, { force: true });
        } else {
          await mkdir(dirname(item.path), { recursive: true });
          await writeFile(item.path, item.nextContent);
        }
        mutations.push({
          path: item.path,
          previousContent: item.previousContent,
          nextContent: item.nextContent,
        });
      }

      options.recordFileMutations(mutations);

      return {
        output: `applied patch to ${pending.length} file${pending.length === 1 ? '' : 's'}:\n${summarize(pending)}`,
        fileChanges,
      };
    },
  } satisfies Tool;
}
