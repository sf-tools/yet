import stringWidth from 'string-width';

export const stripAnsi = (s: string) => s.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
export const widthOf = (s: string) => stringWidth(stripAnsi(s));
export const repeat = (ch: string, count: number) => ch.repeat(Math.max(0, count));
export const plain = (s: string) => stripAnsi(s).replace(/\r/g, '');

export function truncateToWidth(text: string, maxWidth: number) {
  if (maxWidth <= 0) return '';
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
