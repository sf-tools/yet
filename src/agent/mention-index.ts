import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import path from 'node:path';
import fuzzysort, { type SnapshotKey } from 'fuzzysort';

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
const EXCLUDED_NAMES = new Set(['.git']);

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

function searchEntries(entries: MentionIndexEntry[], query: string, limit: number) {
  const normalizedQuery = normalizePath(query);
  if (!normalizedQuery) return [];

  return fuzzysort
    .go(normalizedQuery, entries, {
      key: 'searchPath',
      limit,
      threshold: 0,
    })
    .slice()
    .sort((left, right) => right.score - left.score || left.obj.label.localeCompare(right.obj.label))
    .map(result => result.obj);
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
        '--follow',
        '--glob',
        '!.git',
        '--glob',
        '!.git/**',
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
  private snapshot: SnapshotKey<MentionIndexEntry> | null = null;
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
    const normalizedQuery = normalizePath(query);
    if (!normalizedQuery || !this.snapshot) return [];

    return fuzzysort
      .go(normalizedQuery, this.snapshot, { limit, threshold: 0 })
      .slice()
      .sort(
        (left, right) =>
          right.score - left.score || left.obj.label.localeCompare(right.obj.label),
      )
      .map(result => result.obj);
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
    this.snapshot = fuzzysort.snapshot(this.entries, { key: 'searchPath' });
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
