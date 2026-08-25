import { existsSync, statSync } from 'node:fs';
import { extname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);

export const IMAGE_MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml'
};

function unescapeShellPath(value: string) {
  return value.replace(/\\(.)/g, '$1');
}

function decodeFileUrl(value: string) {
  if (!/^file:\/\//i.test(value)) return value;
  try {
    return fileURLToPath(value);
  } catch {
    return value;
  }
}

function trimQuotes(value: string) {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return value.slice(1, -1);
  }
  return value;
}

/**
 * Tokenize a string the way a shell would for path arguments. Honors single
 * quotes, double quotes, and backslash-escaped spaces. Used to split
 * drag-and-drop payloads — terminals send paths in any of these forms
 * depending on platform.
 */
export function shellSplitPaths(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

export type DroppedPath = { rawToken: string; absolutePath: string; mediaType: string; ext: string };

/**
 * Try to interpret a piece of pasted text as one or more dropped image file
 * paths. Returns null when the text isn't shaped like a list of existing
 * image paths — caller should treat it as plain text in that case.
 */
export function parseDroppedImagePaths(input: string, cwd = process.cwd()): DroppedPath[] | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (trimmed.includes('\n')) return null;

  const tokens = shellSplitPaths(trimmed);
  if (tokens.length === 0) return null;

  const results: DroppedPath[] = [];
  for (const token of tokens) {
    const candidate = unescapeShellPath(decodeFileUrl(trimQuotes(token)));
    if (!candidate) return null;
    const absolute = isAbsolute(candidate) ? candidate : resolve(cwd, candidate);
    const ext = extname(absolute).toLowerCase();
    const mediaType = IMAGE_MEDIA_TYPES[ext];
    if (!mediaType) return null;
    if (!existsSync(absolute)) return null;
    try {
      if (!statSync(absolute).isFile()) return null;
    } catch {
      return null;
    }
    results.push({ rawToken: token, absolutePath: absolute, mediaType, ext });
  }
  return results.length > 0 ? results : null;
}
