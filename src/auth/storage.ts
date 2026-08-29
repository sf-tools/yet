import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

import type { StoredOpenAIAuth } from './types';

export const YET_AUTH_PATH = join(homedir(), '.yet', 'auth.json');

function requiredString(value: unknown, label: string) {
  if (typeof value !== 'string' || value.trim().length === 0)
    throw new Error(`invalid OpenAI credentials: ${label} is missing`);
  return value;
}

export function parseStoredOpenAIAuth(value: unknown): StoredOpenAIAuth {
  if (!value || typeof value !== 'object') throw new Error('invalid OpenAI credentials file');
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== 1 || candidate.provider !== 'openai')
    throw new Error('unsupported OpenAI credentials file');

  if (candidate.method === 'api-key') {
    return {
      version: 1,
      provider: 'openai',
      method: 'api-key',
      apiKey: requiredString(candidate.apiKey, 'API key'),
      updatedAt: requiredString(candidate.updatedAt, 'updatedAt'),
    };
  }

  if (candidate.method === 'oauth') {
    return {
      version: 1,
      provider: 'openai',
      method: 'oauth',
      accessToken: requiredString(candidate.accessToken, 'access token'),
      refreshToken: requiredString(candidate.refreshToken, 'refresh token'),
      idToken: requiredString(candidate.idToken, 'ID token'),
      accountId: requiredString(candidate.accountId, 'account ID'),
      ...(typeof candidate.email === 'string' ? { email: candidate.email } : {}),
      ...(typeof candidate.plan === 'string' ? { plan: candidate.plan } : {}),
      ...(typeof candidate.expiresAt === 'number' ? { expiresAt: candidate.expiresAt } : {}),
      ...(typeof candidate.fedramp === 'boolean' ? { fedramp: candidate.fedramp } : {}),
      updatedAt: requiredString(candidate.updatedAt, 'updatedAt'),
    };
  }

  throw new Error('unsupported OpenAI authentication method');
}

export async function loadStoredOpenAIAuth(path = YET_AUTH_PATH): Promise<StoredOpenAIAuth | null> {
  try {
    return parseStoredOpenAIAuth(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function saveStoredOpenAIAuth(auth: StoredOpenAIAuth, path = YET_AUTH_PATH) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(auth, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    await rename(temporaryPath, path);
    if (process.platform !== 'win32') await chmod(path, 0o600);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
}

export async function deleteStoredOpenAIAuth(path = YET_AUTH_PATH) {
  await rm(path, { force: true });
}
