import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import path from 'node:path';
import Fuse, { type IFuseOptions } from 'fuse.js';

export type MentionIndexEntry = {
  kind: 'file' | 'folder';
  label: string;
  name: string;
  searchPath: string;
};

export enum MentionIndexState {
  Unstarted = 'unstarted',
  Initializing = 'initializing',
  Ready = 'ready',
  Failed = 'failed',
}

export type MentionIndexStats = {
  state: MentionIndexState;
  files: number;
  folders: number;
  entries: number;
  indexedAt: number | null;
  lastError: string | null;
};

const WORKSPACE_SEARCH_LIMIT = 24;
const MAX_RG_BUFFER_BYTES = 64 * 1024 * 1024;
const EXCLUDED_NAMES = new Set(['.git', 'node_modules', 'dist', '.DS_Store']);

const FUZZY_OPTIONS: IFuseOptions<MentionIndexEntry> = {
  includeScore: true,
  ignoreLocation: true,
  threshold: 0.4,
  keys: [
    { name: 'name', weight: 0.65 },
    { name: 'searchPath', weight: 0.35 },
  ],
};

function normalizePath(value: string) {
  return value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/^\//, '').trim();
}

function parentDirectoriesFor(filePath: string) {
  const parts = normalizePath(filePath).split('/').filter(Boolean);
  const directories: string[] = [];

  for (let index = 1; index < parts.length; index += 1) {
    directories.push(`${parts.slice(0, index).join('/')}/`);
  }

  return directories;
}

function compareEntries(a: MentionIndexEntry, b: MentionIndexEntry) {
  if (a.kind !== b.kind) return a.kind === 'file' ? -1 : 1;
  return a.label.localeCompare(b.label);
}

function searchPriority(entry: MentionIndexEntry, rawQuery: string) {
  const query = normalizePath(rawQuery).toLowerCase();
  if (!query) return entry.kind === 'folder' ? 1 : 0;

  const name = entry.name.toLowerCase();
  const searchPath = entry.searchPath.toLowerCase();
  const pathSegments = searchPath.split('/');

  let priority = 0;

  if (
    searchPath === query ||
    `${searchPath}/` === query ||
    `${query}/` === entry.label.toLowerCase()
  )
    priority += 1000;
  if (name === query) priority += 800;
  if (name.startsWith(query)) priority += 400;
  if (searchPath.startsWith(query)) priority += 250;
  if (searchPath.includes(`/${query}`)) priority += 120;
  if (pathSegments.some(segment => segment.startsWith(query))) priority += 80;
  if (entry.kind === 'folder') priority -= 25;

  return priority;
}

function searchEntries(entries: MentionIndexEntry[], query: string, limit: number) {
  if (!query) return [...entries].sort(compareEntries).slice(0, limit);

  const fuse = new Fuse(entries, FUZZY_OPTIONS);
  return fuse
    .search(normalizePath(query), { limit })
    .sort((left, right) => {
      if (left.item.kind !== right.item.kind) return left.item.kind === 'file' ? -1 : 1;

      const priorityDiff = searchPriority(right.item, query) - searchPriority(left.item, query);
      if (priorityDiff !== 0) return priorityDiff;

      const scoreDiff = (left.score ?? 0) - (right.score ?? 0);
      if (scoreDiff !== 0) return scoreDiff;

      return compareEntries(left.item, right.item);
    })
    .map(result => result.item);
}

function execFileText(file: string, args: string[], cwd: string) {
  return new Promise<string>((resolvePromise, rejectPromise) => {
    execFile(
      file,
      args,
      { cwd, encoding: 'utf8', maxBuffer: MAX_RG_BUFFER_BYTES },
      (error, stdout) => {
        if (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === '1') {
            resolvePromise(stdout);
            return;
          }

          rejectPromise(error);
          return;
        }

        resolvePromise(stdout);
      },
    );
  });
}

function isMissingExecutableError(error: unknown) {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT',
  );
}

async function listWorkspaceFilesWithNodeFs(
  cwd: string,
  relativeDirectory = '',
): Promise<string[]> {
  const directoryPath = relativeDirectory ? path.join(cwd, relativeDirectory) : cwd;
  const directoryEntries = await readdir(directoryPath, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of directoryEntries) {
    if (EXCLUDED_NAMES.has(entry.name) || entry.isSymbolicLink()) continue;

    const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    const normalizedRelativePath = normalizePath(relativePath);

    if (entry.isDirectory()) {
      files.push(...(await listWorkspaceFilesWithNodeFs(cwd, normalizedRelativePath)));
      continue;
    }

    if (entry.isFile()) files.push(normalizedRelativePath);
  }

  return files;
}

async function listWorkspaceFiles(cwd: string) {
  try {
    const stdout = await execFileText(
      'rg',
      [
        '--files',
        '--hidden',
        '--glob',
        '!.git',
        '--glob',
        '!.git/**',
        '--glob',
        '!node_modules',
        '--glob',
        '!node_modules/**',
        '--glob',
        '!dist',
        '--glob',
        '!dist/**',
        '--glob',
        '!.DS_Store',
      ],
      cwd,
    );

    return stdout
      .split(/\r?\n/g)
      .map(line => normalizePath(line))
      .filter(Boolean);
  } catch (error) {
    if (isMissingExecutableError(error)) return listWorkspaceFilesWithNodeFs(cwd);
    throw error;
  }
}

function buildEntries(filePaths: string[]) {
  const files: MentionIndexEntry[] = [];
  const folders = new Map<string, MentionIndexEntry>();

  for (const filePath of filePaths) {
    const normalizedPath = normalizePath(filePath);
    if (!normalizedPath) continue;

    files.push({
      kind: 'file',
      label: normalizedPath,
      name: path.posix.basename(normalizedPath),
      searchPath: normalizedPath,
    });

    for (const directory of parentDirectoriesFor(normalizedPath)) {
      if (folders.has(directory)) continue;

      const searchPath = directory.slice(0, -1);
      folders.set(directory, {
        kind: 'folder',
        label: directory,
        name: path.posix.basename(searchPath),
        searchPath,
      });
    }
  }

  const entries = [...folders.values(), ...files];
  return {
    entries,
    files: files.length,
    folders: folders.size,
  };
}

class WorkspaceMentionIndex {
  private state = MentionIndexState.Unstarted;
  private initPromise: Promise<void> | null = null;
  private entries: MentionIndexEntry[] = [];
  private fuse: Fuse<MentionIndexEntry> | null = null;
  private fileCount = 0;
  private folderCount = 0;
  private indexedAt: number | null = null;
  private lastError: string | null = null;

  constructor(readonly cwd: string) {}

  startInBackground() {
    if (this.initPromise || this.state === MentionIndexState.Ready) return;

    this.state = MentionIndexState.Initializing;
    this.lastError = null;
    this.initPromise = this.initialize()
      .catch(error => {
        this.state = MentionIndexState.Failed;
        this.lastError = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        this.initPromise = null;
      });
  }

  async waitForReady() {
    this.startInBackground();
    if (this.initPromise) await this.initPromise;
  }

  query(query: string, limit = WORKSPACE_SEARCH_LIMIT) {
    this.startInBackground();
    if (!this.fuse) return [];

    return this.fuse
      .search(normalizePath(query), { limit })
      .sort((left, right) => {
        if (left.item.kind !== right.item.kind) return left.item.kind === 'file' ? -1 : 1;

        const priorityDiff = searchPriority(right.item, query) - searchPriority(left.item, query);
        if (priorityDiff !== 0) return priorityDiff;

        const scoreDiff = (left.score ?? 0) - (right.score ?? 0);
        if (scoreDiff !== 0) return scoreDiff;

        return compareEntries(left.item, right.item);
      })
      .map(result => result.item);
  }

  getStats(): MentionIndexStats {
    return {
      state: this.state,
      files: this.fileCount,
      folders: this.folderCount,
      entries: this.entries.length,
      indexedAt: this.indexedAt,
      lastError: this.lastError,
    };
  }

  private async initialize() {
    const filePaths = await listWorkspaceFiles(this.cwd);
    const built = buildEntries(filePaths);

    this.entries = built.entries;
    this.fileCount = built.files;
    this.folderCount = built.folders;
    this.fuse = new Fuse(this.entries, FUZZY_OPTIONS);
    this.indexedAt = Date.now();
    this.state = MentionIndexState.Ready;
  }
}

const mentionIndexes = new Map<string, WorkspaceMentionIndex>();

function getOrCreateMentionIndex(cwd: string) {
  const root = resolve(cwd);
  const existing = mentionIndexes.get(root);
  if (existing) return existing;

  const created = new WorkspaceMentionIndex(root);
  mentionIndexes.set(root, created);
  return created;
}

export function startMentionIndex(cwd = process.cwd()) {
  const index = getOrCreateMentionIndex(cwd);
  index.startInBackground();
  return index;
}

export function getMentionIndexStats(cwd = process.cwd()) {
  return getOrCreateMentionIndex(cwd).getStats();
}

export function queryMentionIndex(
  query: string,
  limit = WORKSPACE_SEARCH_LIMIT,
  cwd = process.cwd(),
) {
  return getOrCreateMentionIndex(cwd).query(query, limit);
}

export async function queryMentionIndexAwait(
  query: string,
  limit = WORKSPACE_SEARCH_LIMIT,
  cwd = process.cwd(),
) {
  const index = getOrCreateMentionIndex(cwd);
  await index.waitForReady();
  return index.query(query, limit);
}

export function fallbackSearchMentionEntries(
  entries: MentionIndexEntry[],
  query: string,
  limit: number,
) {
  return searchEntries(entries, query, limit);
}
