import { openSync } from 'node:fs';
import { ReadStream, isatty } from 'node:tty';

type EarlyStdinState = {
  buffer: Buffer[];
  listener: ((data: Buffer | string) => void) | null;
  stream: ReadStream | null;
  started: boolean;
  takenOver: boolean;
};

const OSC_RESPONSE_PATTERN = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

const earlyStdin: EarlyStdinState = {
  buffer: [],
  listener: null,
  stream: null,
  started: false,
  takenOver: false,
};

function isOldBunWithTTYBug() {
  const bunVersion = process.versions.bun;
  if (!bunVersion) return false;

  const [major = 0, minor = 0, patch = 0] = bunVersion.split('.').map(Number);
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) return false;
  if (major !== 1 || minor !== 2) return false;
  return patch < 22;
}

function cleanupEarlyStream() {
  if (earlyStdin.takenOver) return;

  const stream = earlyStdin.stream;
  const listener = earlyStdin.listener;
  if (!stream) return;

  try {
    if (listener) stream.off('data', listener);
  } catch {}

  try {
    if (stream.isTTY) stream.setRawMode(false);
  } catch {}

  try {
    stream.pause();
  } catch {}

  try {
    if (stream !== process.stdin) stream.destroy();
  } catch {}

  earlyStdin.listener = null;
  earlyStdin.stream = null;
}

function setupEarlyStream(stream: ReadStream) {
  stream.setRawMode(true);
  stream.resume();

  const listener = (data: Buffer | string) => {
    earlyStdin.buffer.push(typeof data === 'string' ? Buffer.from(data) : Buffer.from(data));
  };

  stream.on('data', listener);
  earlyStdin.listener = listener;
  earlyStdin.stream = stream;

  process.once('exit', cleanupEarlyStream);
  process.once('SIGINT', cleanupEarlyStream);
  process.once('SIGTERM', cleanupEarlyStream);
}

export function startEarlyStdinCapture() {
  if (earlyStdin.started) return;
  earlyStdin.started = true;

  const isWindows = process.platform === 'win32';
  const isBadBun = isOldBunWithTTYBug();

  if (!isWindows && !isBadBun) {
    try {
      const fd = openSync('/dev/tty', 'r');
      if (isatty(fd)) {
        setupEarlyStream(new ReadStream(fd));
        return;
      }
    } catch {}
  }

  if (process.stdin.isTTY) setupEarlyStream(process.stdin);
}

function sanitizeBufferedInput(buffer: Buffer[]) {
  if (buffer.length === 0) return buffer;

  const text = Buffer.concat(buffer).toString('utf8');
  const sanitized = text.replace(OSC_RESPONSE_PATTERN, '');
  return sanitized ? [Buffer.from(sanitized)] : [];
}

export function getEarlyStdinStream() {
  return earlyStdin.stream;
}

export function takeOverEarlyStdin() {
  const stream = earlyStdin.stream;
  const listener = earlyStdin.listener;
  const buffer = sanitizeBufferedInput(earlyStdin.buffer.splice(0));

  if (!stream) return { stream: null, buffer };

  earlyStdin.takenOver = true;
  if (listener) stream.off('data', listener);
  earlyStdin.listener = null;

  return { stream, buffer };
}
