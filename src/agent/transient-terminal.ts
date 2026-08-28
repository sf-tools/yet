import { widthOf } from '@/text';

export function clampTransientLines(lines: string[], terminalRows: number) {
  const maxLines = Math.max(1, Math.floor(terminalRows) - 1);
  return lines.length > maxLines ? lines.slice(-maxLines) : lines;
}

export function takeBlockTail<T>(blocks: readonly (readonly T[])[], maxItems: number) {
  let remaining = Math.max(0, Math.floor(maxItems));
  const slices: T[][] = [];

  for (let index = blocks.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const block = blocks[index];
    if (block.length === 0) continue;
    const start = Math.max(0, block.length - remaining);
    const slice = block.slice(start);
    slices.push([...slice]);
    remaining -= slice.length;
  }

  slices.reverse();
  return slices.flat();
}

export function clearTransientSequence(lineCount: number) {
  if (lineCount <= 0) return '';
  const moveToTop = lineCount > 1 ? `\u001b[${lineCount - 1}F` : '\r';
  return `${moveToTop}\u001b[${lineCount}M`;
}

export function synchronizedTerminalSequence(sequence: string) {
  return sequence ? `\u001b[?2026h${sequence}\u001b[?2026l` : '';
}

export function patchTransientSequence(previous: string[], next: string[]) {
  if (previous.length === 0 || previous.length !== next.length) return null;

  const changedRows = next.flatMap((line, index) => (line === previous[index] ? [] : [index]));
  if (changedRows.length === 0) return '';

  let output = '';
  let currentRow = next.length - 1;

  for (const row of changedRows) {
    const delta = row - currentRow;
    if (delta > 0) output += `\u001b[${delta}E`;
    else if (delta < 0) output += `\u001b[${-delta}F`;
    else output += '\r';

    output += `\u001b[2K\r${next[row]}`;
    currentRow = row;
  }

  const lastRow = next.length - 1;
  const delta = lastRow - currentRow;
  if (delta > 0) output += `\u001b[${delta}E`;
  else if (delta < 0) output += `\u001b[${-delta}F`;
  output += '\r';

  return output;
}

export function reconcileTransientSequence(previous: string[], next: string[]) {
  if (previous.length === 0) return next.join('\n');
  if (next.length === 0) return clearTransientSequence(previous.length);
  if (previous.length === next.length) return patchTransientSequence(previous, next) ?? '';

  if (next.length > previous.length) {
    const addedRows = next.length - previous.length;
    const allocateRows = '\r\n'.repeat(addedRows);
    const paddedPrevious = [...previous, ...Array.from({ length: addedRows }, () => '')];
    return `${allocateRows}${patchTransientSequence(paddedPrevious, next) ?? ''}`;
  }

  const removedRows = previous.length - next.length;
  const moveToNewBottom = `\u001b[${removedRows}F`;
  const patch = patchTransientSequence(previous.slice(0, next.length), next) ?? '';
  const clearTrailingRows = '\u001b[1B\u001b[0J\u001b[1A\r';
  return `${moveToNewBottom}${patch}${clearTrailingRows}`;
}

type ScreenScrollRegion = {
  startRow: number;
  endRow: number;
};

type ScreenDiffOptions = {
  scrollRegion?: ScreenScrollRegion;
  terminalWidth?: number;
};

function rowsFitTerminal(lines: readonly string[], terminalWidth: number | undefined) {
  if (terminalWidth === undefined) return false;
  const safeWidth = Math.max(1, Math.floor(terminalWidth));
  return lines.every(line => widthOf(line) <= safeWidth);
}

function shiftedScreenRows(
  previous: string[],
  next: string[],
  region: ScreenScrollRegion,
) {
  const start = Math.max(0, Math.floor(region.startRow));
  const end = Math.min(previous.length, next.length, Math.floor(region.endRow) + 1);
  const height = end - start;
  if (height <= 1) return null;

  for (let amount = 1; amount < height; amount += 1) {
    const scrollsUp = previous
      .slice(start + amount, end)
      .every((line, index) => line === next[start + index]);
    if (scrollsUp) {
      const shifted = [...previous];
      shifted.splice(start, height, ...previous.slice(start + amount, end), ...Array.from({ length: amount }, () => ''));
      return {
        shifted,
        sequence: `\u001b[${start + 1};${end}r\u001b[${amount}S\u001b[r`,
      };
    }

    const scrollsDown = previous
      .slice(start, end - amount)
      .every((line, index) => line === next[start + amount + index]);
    if (scrollsDown) {
      const shifted = [...previous];
      shifted.splice(start, height, ...Array.from({ length: amount }, () => ''), ...previous.slice(start, end - amount));
      return {
        shifted,
        sequence: `\u001b[${start + 1};${end}r\u001b[${amount}T\u001b[r`,
      };
    }
  }

  return null;
}

export function diffScreenRowsSequence(
  previous: string[],
  next: string[],
  options: ScreenDiffOptions = {},
) {
  if (previous.length === next.length && previous.every((line, index) => line === next[index])) {
    return '';
  }
  if (previous.length === 0) return `\u001b[2J\u001b[H${next.join('\n')}`;

  const canScroll =
    options.scrollRegion !== undefined &&
    previous.length === next.length &&
    rowsFitTerminal(previous, options.terminalWidth) &&
    rowsFitTerminal(next, options.terminalWidth);
  const shifted = canScroll
    ? shiftedScreenRows(previous, next, options.scrollRegion!)
    : null;
  const comparison = shifted?.shifted ?? previous;
  let output = shifted?.sequence ?? '';
  const rowCount = Math.max(previous.length, next.length);
  for (let row = 0; row < rowCount; row += 1) {
    const line = next[row] ?? '';
    if (line === (comparison[row] ?? '')) continue;
    output += `\u001b[${row + 1};1H\u001b[2K${line}`;
  }
  output += `\u001b[${Math.max(1, next.length)};1H`;
  return output;
}
