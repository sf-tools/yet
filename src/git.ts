import fs from 'node:fs';
import * as git from 'isomorphic-git';

type BranchCacheEntry = {
  value: string | null;
  at: number;
  pending: Promise<string | null> | null;
};

const branchCache = new Map<string, BranchCacheEntry>();

export function getCachedGitBranch(cwd: string) {
  return branchCache.get(cwd)?.value ?? null;
}

export async function refreshGitBranch(cwd: string) {
  const cached = branchCache.get(cwd);
  const now = Date.now();

  if (cached?.pending) return cached.pending;
  if (cached && now - cached.at < 1_000) return cached.value;

  const pending = (async () => {
    try {
      const branch = await git.currentBranch({ fs, dir: cwd, fullname: false, test: true });
      return branch && branch !== 'HEAD' ? branch : null;
    } catch {
      return null;
    }
  })();

  branchCache.set(cwd, { value: cached?.value ?? null, at: cached?.at ?? 0, pending });

  const value = await pending;
  branchCache.set(cwd, { value, at: Date.now(), pending: null });
  return value;
}
