import { mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export type PromptHistoryEntry = {
  text: string;
  cwd?: string;
  createdAt?: string;
};

const DEFAULT_HISTORY_PATH = join(homedir(), '.yet', 'prompt-history.jsonl');
const DEFAULT_HISTORY_SIZE = 1000;

export class PromptHistoryStore {
  private entries: PromptHistoryEntry[] = [];
  private loaded = false;

  constructor(
    private readonly historyPath = DEFAULT_HISTORY_PATH,
    private readonly maxSize = DEFAULT_HISTORY_SIZE,
  ) {}

  private async ensureLoaded() {
    if (this.loaded) return;

    try {
      await unlink(`${this.historyPath}.lock`);
    } catch {}

    try {
      const content = await readFile(this.historyPath, 'utf8');
      const parsed = content
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .flatMap(line => {
          try {
            const value = JSON.parse(line) as PromptHistoryEntry | string;
            if (typeof value === 'string') return [{ text: value } satisfies PromptHistoryEntry];
            if (value && typeof value.text === 'string') return [value];
          } catch {}
          return [];
        });

      this.entries = parsed;
    } catch {}

    this.loaded = true;
  }

  private async rewrite(entries: PromptHistoryEntry[]) {
    await mkdir(dirname(this.historyPath), { recursive: true });
    const body = entries.map(entry => JSON.stringify(entry)).join('\n');
    await writeFile(this.historyPath, body ? `${body}\n` : '', { encoding: 'utf8', mode: 0o600 });
  }

  private async appendAtomic(entry: PromptHistoryEntry) {
    const lockPath = `${this.historyPath}.lock`;
    const line = `${JSON.stringify(entry)}\n`;

    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        const lock = await open(lockPath, 'wx');
        try {
          await mkdir(dirname(this.historyPath), { recursive: true });
          await writeFile(this.historyPath, line, { flag: 'a', encoding: 'utf8', mode: 0o600 });
        } finally {
          await lock.close();
          try {
            await unlink(lockPath);
          } catch {}
        }
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EEXIST' && attempt < 9) {
          await new Promise(resolve => setTimeout(resolve, 50));
          continue;
        }

        throw error;
      }
    }
  }

  async add(text: string, cwd: string) {
    const trimmed = text.trim();
    if (!trimmed) return;

    await this.ensureLoaded();

    if (this.entries.at(-1)?.text === trimmed) return;

    const entry: PromptHistoryEntry = {
      createdAt: new Date().toISOString(),
      cwd: resolve(cwd),
      text: trimmed,
    };

    await this.appendAtomic(entry);
    this.entries.push(entry);

    if (this.entries.length > this.maxSize) {
      this.entries = this.entries.slice(-this.maxSize);
      await this.rewrite(this.entries);
    }
  }

  async listForWorkspace(cwd: string) {
    await this.ensureLoaded();
    const workspace = resolve(cwd);
    const seen = new Set<string>();
    const result: PromptHistoryEntry[] = [];

    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      const entry = this.entries[index];
      if (!entry) continue;
      if (entry.cwd && resolve(entry.cwd) !== workspace) continue;
      if (seen.has(entry.text)) continue;
      seen.add(entry.text);
      result.push(entry);
    }

    return result;
  }
}
