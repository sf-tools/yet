import stringWidth from 'string-width';

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;
const BLOCK_ELEMENTS = /[\u2580-\u259f]/g;

export const isPrintableAscii = (text: string) => PRINTABLE_ASCII.test(text);

export const stripAnsi = (s: string) => {
  if (!s.includes('\x1B') && !s.includes('\x9B')) return s;
  return s
    .replace(/\x1B\][\s\S]*?(?:\x07|\x1B\\)/g, '')
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
};

export const widthOf = (s: string) => {
  if (isPrintableAscii(s)) return s.length;
  const stripped = stripAnsi(s);
  // Ant's Intl.Segmenter can overcount block-element runs when they are mixed
  // into a longer ASCII line. Terminals render these progress-bar cells as one
  // column each, so normalize only that range before asking string-width.
  return stringWidth(stripped.replace(BLOCK_ELEMENTS, 'x'));
};
export const repeat = (ch: string, count: number) => ch.repeat(Math.max(0, count));
export const plain = (s: string) => {
  const stripped = stripAnsi(s);
  return stripped.includes('\r') ? stripped.replace(/\r/g, '') : stripped;
};

export function truncateToWidth(text: string, maxWidth: number) {
  if (maxWidth <= 0) return '';
  if (isPrintableAscii(text)) {
    if (text.length <= maxWidth) return text;
    return maxWidth === 1 ? '…' : `${text.slice(0, maxWidth - 1)}…`;
  }
  if (widthOf(text) <= maxWidth) return text;
  if (maxWidth === 1) return '…';

  let out = '';

  for (const ch of Array.from(text)) {
    if (widthOf(`${out}${ch}…`) > maxWidth) break;
    out += ch;
  }

  return `${out}…`;
}

export function normalizePtyOutput(text: string) {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '');
}

export function formatWorkspacePath(path: string) {
  const home = process.env.HOME;
  if (home && path.startsWith(home)) return `~${path.slice(home.length)}`;
  return path;
}

function wrapLine(line: string, width: number) {
  if (width <= 0) return [''];
  if (!line) return [''];
  if (isPrintableAscii(line)) {
    const out: string[] = [];
    for (let offset = 0; offset < line.length; offset += width)
      out.push(line.slice(offset, offset + width));
    return out;
  }

  const out: string[] = [];
  let current = '';
  let currentWidth = 0;

  for (const ch of Array.from(line)) {
    const w = Math.max(1, widthOf(ch));

    if (current && currentWidth + w > width) {
      out.push(current);
      current = ch;
      currentWidth = w;
      continue;
    }

    current += ch;
    currentWidth += w;
  }

  out.push(current);
  return out;
}

export function wrapText(text: string, width: number) {
  return plain(text)
    .split('\n')
    .flatMap(line => wrapLine(line, width));
}

export function installSegmentContainingPolyfill() {
  if (typeof Intl?.Segmenter !== 'function') return;

  const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment('');
  const proto = Object.getPrototypeOf(segments) as {
    containing?: (index: number) => unknown;
  };

  if (typeof proto.containing === 'function') return;

  Object.defineProperty(proto, 'containing', {
    value(index: number) {
      if (typeof index !== 'number' || index < 0) return undefined;

      for (const segment of this as Iterable<{ index: number; segment: string }>) {
        const start = segment.index;
        const end = start + segment.segment.length;
        if (index >= start && index < end) return segment;
      }

      return undefined;
    },
  });
}
