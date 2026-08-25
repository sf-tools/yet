import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type YetCloudAuth = {
  baseUrl: string;
  accessToken: string;
  userId?: string | null;
  email?: string | null;
  savedAt: string;
};

export const YET_CLOUD_AUTH_PATH = join(homedir(), '.yet', 'cloud-auth.json');

export const YET_CLOUD_BASE_URL = 'https://yet.sf.tools';

export function defaultYetCloudUrl() {
  return YET_CLOUD_BASE_URL;
}

export async function loadYetCloudAuth(path = YET_CLOUD_AUTH_PATH): Promise<YetCloudAuth | null> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as Partial<YetCloudAuth>;

    if (!parsed || typeof parsed.baseUrl !== 'string' || typeof parsed.accessToken !== 'string') {
      return null;
    }

    return {
      accessToken: parsed.accessToken,
      baseUrl: parsed.baseUrl,
      email: typeof parsed.email === 'string' ? parsed.email : null,
      savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : new Date().toISOString(),
      userId: typeof parsed.userId === 'string' ? parsed.userId : null,
    };
  } catch {
    return null;
  }
}

export async function saveYetCloudAuth(auth: YetCloudAuth, path = YET_CLOUD_AUTH_PATH) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(auth, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

export async function clearYetCloudAuth(path = YET_CLOUD_AUTH_PATH) {
  await rm(path, { force: true });
}
