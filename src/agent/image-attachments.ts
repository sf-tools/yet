import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, join } from 'node:path';

import { IMAGE_MEDIA_TYPES } from './path-detect';

export const IMAGE_TOKEN_PATTERN = /\[image:([a-f0-9]{8})\]/g;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

const ATTACHMENT_DIR = join(homedir(), '.yet', 'attachments');

export type Attachment = {
  token: string;
  hash: string;
  path: string;
  mediaType: string;
  bytes: number;
  originalName: string;
  dimensions: { width: number; height: number } | null;
};

const attachments = new Map<string, Attachment>();

function readPngDimensions(bytes: Uint8Array) {
  if (bytes.length < 24) return null;
  if (bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16, false), height: view.getUint32(20, false) };
}

function readGifDimensions(bytes: Uint8Array) {
  if (bytes.length < 10 || bytes[0] !== 0x47 || bytes[1] !== 0x49 || bytes[2] !== 0x46) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
}

function readJpegDimensions(bytes: Uint8Array) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1];
    i += 2;
    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (i + 7 > bytes.length) return null;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      return { width: view.getUint16(i + 5, false), height: view.getUint16(i + 3, false) };
    }
    if (i + 2 > bytes.length) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    i += view.getUint16(i, false);
  }
  return null;
}

function inferDimensions(bytes: Uint8Array, mediaType: string) {
  if (mediaType === 'image/png') return readPngDimensions(bytes);
  if (mediaType === 'image/jpeg') return readJpegDimensions(bytes);
  if (mediaType === 'image/gif') return readGifDimensions(bytes);
  return null;
}

function extForMediaType(mediaType: string) {
  for (const [ext, type] of Object.entries(IMAGE_MEDIA_TYPES)) {
    if (type === mediaType) return ext;
  }
  return '.bin';
}

function tokenFromHash(hash: string) {
  return `[image:${hash.slice(0, 8)}]`;
}

async function persistBytes(bytes: Uint8Array, hash: string, ext: string): Promise<string> {
  await mkdir(ATTACHMENT_DIR, { recursive: true });
  const target = join(ATTACHMENT_DIR, `${hash}${ext}`);
  if (!existsSync(target)) await writeFile(target, bytes);
  return target;
}

function register(record: Attachment) {
  attachments.set(record.token, record);
}

export async function attachFromBytes(
  bytes: Uint8Array,
  mediaType: string,
  originalName?: string
): Promise<Attachment> {
  if (bytes.length === 0) throw new Error('image is empty');
  if (bytes.length > MAX_ATTACHMENT_BYTES) {
    throw new Error(`image is too large: ${bytes.length} bytes (max ${MAX_ATTACHMENT_BYTES})`);
  }
  const hash = createHash('sha256').update(bytes).digest('hex');
  const token = tokenFromHash(hash);
  const cached = attachments.get(token);
  if (cached) return cached;
  const ext = extForMediaType(mediaType);
  const path = await persistBytes(bytes, hash, ext);
  const record: Attachment = {
    token,
    hash,
    path,
    mediaType,
    bytes: bytes.length,
    originalName: originalName ?? basename(path),
    dimensions: inferDimensions(bytes, mediaType)
  };
  register(record);
  return record;
}

export async function attachFromPath(path: string): Promise<Attachment> {
  const ext = extname(path).toLowerCase();
  const mediaType = IMAGE_MEDIA_TYPES[ext];
  if (!mediaType) throw new Error(`unsupported image type: ${ext || '(no extension)'}`);
  const bytes = readFileSync(path);
  return attachFromBytes(new Uint8Array(bytes), mediaType, basename(path));
}

export function findAttachment(token: string): Attachment | undefined {
  return attachments.get(token);
}

export function summarizeAttachment(attachment: Attachment): string {
  const sizeKb = (attachment.bytes / 1024).toFixed(1);
  const dim = attachment.dimensions ? ` · ${attachment.dimensions.width}×${attachment.dimensions.height}` : '';
  return `[image · ${attachment.originalName}${dim} · ${sizeKb} KB]`;
}

export function replaceTokensWithSummary(text: string): string {
  return text.replace(IMAGE_TOKEN_PATTERN, (match, hash: string) => {
    const attachment = attachments.get(`[image:${hash}]`);
    return attachment ? summarizeAttachment(attachment) : match;
  });
}

export function extractTokens(text: string): string[] {
  const tokens: string[] = [];
  for (const match of text.matchAll(IMAGE_TOKEN_PATTERN)) tokens.push(match[0]);
  return tokens;
}
