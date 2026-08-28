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
  return `${moveToTop}\u001b[0J`;
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
