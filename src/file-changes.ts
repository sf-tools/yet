import { readFile } from 'node:fs/promises';

import type { DiffStat, FileChange } from '@/types';

export type EditSpec = {
  oldText: string;
  newText: string;
};

type RawDiffOp = {
  type: 'context' | 'add' | 'remove';
  line: string;
};

type DiffOp = RawDiffOp & {
  oldLineStart: number;
  newLineStart: number;
  oldLineNum?: number;
  newLineNum?: number;
};

function asRecord(value: unknown) {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function isEditSpec(value: unknown): value is EditSpec {
  const record = asRecord(value);
  return (
    !!record &&
    typeof record.oldText === 'string' &&
    record.oldText.length > 0 &&
    typeof record.newText === 'string'
  );
}

export function normalizeLineEndings(text: string) {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function splitLines(text: string | null) {
  const normalized = normalizeLineEndings(text ?? '');
  const parts = normalized.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

function diffLines(oldLines: string[], newLines: string[]): RawDiffOp[] {
  const oldCount = oldLines.length;
  const newCount = newLines.length;
  const max = oldCount + newCount;
  let frontier = new Map<number, number>();
  frontier.set(1, 0);
  const trace: Map<number, number>[] = [];

  for (let depth = 0; depth <= max; depth += 1) {
    trace.push(new Map(frontier));

    for (let diagonal = -depth; diagonal <= depth; diagonal += 2) {
      const moveDown =
        diagonal === -depth ||
        (diagonal !== depth &&
          (frontier.get(diagonal - 1) ?? Number.NEGATIVE_INFINITY) <
            (frontier.get(diagonal + 1) ?? Number.NEGATIVE_INFINITY));

      let x = moveDown ? (frontier.get(diagonal + 1) ?? 0) : (frontier.get(diagonal - 1) ?? 0) + 1;
      let y = x - diagonal;

      while (x < oldCount && y < newCount && oldLines[x] === newLines[y]) {
        x += 1;
        y += 1;
      }

      frontier.set(diagonal, x);

      if (x >= oldCount && y >= newCount) return backtrackDiff(trace, oldLines, newLines);
    }
  }

  return [
    ...oldLines.map(line => ({ type: 'remove' as const, line })),
    ...newLines.map(line => ({ type: 'add' as const, line })),
  ];
}

function backtrackDiff(
  trace: Map<number, number>[],
  oldLines: string[],
  newLines: string[],
): RawDiffOp[] {
  let x = oldLines.length;
  let y = newLines.length;
  const ops: RawDiffOp[] = [];

  for (let depth = trace.length - 1; depth >= 0; depth -= 1) {
    const frontier = trace[depth];
    const diagonal = x - y;
    const moveDown =
      diagonal === -depth ||
      (diagonal !== depth &&
        (frontier.get(diagonal - 1) ?? Number.NEGATIVE_INFINITY) <
          (frontier.get(diagonal + 1) ?? Number.NEGATIVE_INFINITY));
    const previousDiagonal = moveDown ? diagonal + 1 : diagonal - 1;
    const previousX = frontier.get(previousDiagonal) ?? 0;
    const previousY = previousX - previousDiagonal;

    while (x > previousX && y > previousY) {
      ops.push({ type: 'context', line: oldLines[x - 1] ?? '' });
      x -= 1;
      y -= 1;
    }

    if (depth === 0) break;

    if (moveDown) {
      ops.push({ type: 'add', line: newLines[y - 1] ?? '' });
      y -= 1;
    } else {
      ops.push({ type: 'remove', line: oldLines[x - 1] ?? '' });
      x -= 1;
    }
  }

  return ops.reverse();
}

function annotateDiff(ops: RawDiffOp[]): DiffOp[] {
  let oldLine = 1;
  let newLine = 1;

  return ops.map(op => {
    const annotated: DiffOp = {
      ...op,
      oldLineStart: oldLine,
      newLineStart: newLine,
    };

    if (op.type === 'context') {
      annotated.oldLineNum = oldLine;
      annotated.newLineNum = newLine;
      oldLine += 1;
      newLine += 1;
      return annotated;
    }

    if (op.type === 'remove') {
      annotated.oldLineNum = oldLine;
      oldLine += 1;
      return annotated;
    }

    annotated.newLineNum = newLine;
    newLine += 1;
    return annotated;
  });
}

function createHunkRanges(ops: DiffOp[], contextLines: number) {
  const ranges: Array<{ start: number; end: number }> = [];

  for (let index = 0; index < ops.length; index += 1) {
    if (ops[index]?.type === 'context') continue;

    const start = Math.max(0, index - contextLines);
    const end = Math.min(ops.length - 1, index + contextLines);
    const previous = ranges[ranges.length - 1];

    if (previous && start <= previous.end + 1) previous.end = Math.max(previous.end, end);
    else ranges.push({ start, end });
  }

  return ranges;
}

function formatRange(start: number, count: number) {
  return count === 1 ? `${start}` : `${start},${count}`;
}

function computeDiffStat(ops: RawDiffOp[]): DiffStat {
  let added = 0;
  let modified = 0;
  let removed = 0;
  let pendingAdds = 0;
  let pendingRemoves = 0;

  const flush = () => {
    const shared = Math.min(pendingAdds, pendingRemoves);
    modified += shared;
    added += Math.max(0, pendingAdds - shared);
    removed += Math.max(0, pendingRemoves - shared);
    pendingAdds = 0;
    pendingRemoves = 0;
  };

  for (const op of ops) {
    if (op.type === 'context') {
      flush();
      continue;
    }

    if (op.type === 'add') pendingAdds += 1;
    else pendingRemoves += 1;
  }

  flush();
  return { added, modified, removed };
}

function buildUnifiedDiff(
  previousContent: string | null,
  nextContent: string | null,
  path: string,
  contextLines = 3,
) {
  const oldLines = splitLines(previousContent);
  const newLines = splitLines(nextContent);
  const ops = diffLines(oldLines, newLines);
  const stats = computeDiffStat(ops);
  const hasTextualChanges = ops.some(op => op.type !== 'context');
  const kind = previousContent === null ? 'created' : nextContent === null ? 'deleted' : 'modified';

  if (!hasTextualChanges) {
    return {
      diff:
        kind === 'modified'
          ? ''
          : [
              `--- ${kind === 'created' ? '/dev/null' : `a/${path}`}`,
              `+++ ${kind === 'deleted' ? '/dev/null' : `b/${path}`}`,
            ].join('\n'),
      stats,
      hasTextualChanges,
      kind,
    } as const;
  }

  const lines: string[] = [];
  lines.push(`--- ${kind === 'created' ? '/dev/null' : `a/${path}`}`);
  lines.push(`+++ ${kind === 'deleted' ? '/dev/null' : `b/${path}`}`);

  const annotatedOps = annotateDiff(ops);
  const ranges = createHunkRanges(annotatedOps, contextLines);

  for (const range of ranges) {
    const slice = annotatedOps.slice(range.start, range.end + 1);
    const first = slice[0];
    if (!first) continue;

    const oldCount = slice.reduce((count, op) => count + (op.type === 'add' ? 0 : 1), 0);
    const newCount = slice.reduce((count, op) => count + (op.type === 'remove' ? 0 : 1), 0);

    lines.push(
      `@@ -${formatRange(first.oldLineStart, oldCount)} +${formatRange(first.newLineStart, newCount)} @@`,
    );

    for (const op of slice) {
      const prefix = op.type === 'add' ? '+' : op.type === 'remove' ? '-' : ' ';
      lines.push(`${prefix}${op.line}`);
    }
  }

  return { diff: lines.join('\n'), stats, hasTextualChanges, kind } as const;
}

function isMissingFileError(error: unknown) {
  return (
    !!error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

export async function readOptionalFile(path: string) {
  try {
    return await readFile(path, 'utf8');
  } catch (error: unknown) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
}

export function findUniqueMatch(content: string, needle: string) {
  let firstIndex = -1;
  let count = 0;
  let searchFrom = 0;

  while (true) {
    const index = content.indexOf(needle, searchFrom);
    if (index === -1) break;
    if (count === 0) firstIndex = index;
    count += 1;
    searchFrom = index + Math.max(1, needle.length);
  }

  if (count === 0) throw new Error('oldText not found');
  if (count > 1) throw new Error('oldText must match exactly once');
  return firstIndex;
}

type Match = {
  index: number;
  oldText: string;
  newText: string;
};

function ensureNonOverlapping(matches: Match[]) {
  const sorted = matches.slice().sort((left, right) => left.index - right.index);

  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (current && previous && current.index < previous.index + previous.oldText.length)
      throw new Error('edits overlap');
  }

  return sorted;
}

export function applyEdits(content: string, edits: EditSpec[]) {
  const matches = ensureNonOverlapping(
    edits.map(edit => ({
      index: findUniqueMatch(content, edit.oldText),
      oldText: edit.oldText,
      newText: edit.newText,
    })),
  );

  let output = content;
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const match = matches[index];
    if (!match) continue;
    output = `${output.slice(0, match.index)}${match.newText}${output.slice(match.index + match.oldText.length)}`;
  }

  return output;
}

export function createFileChange(
  path: string,
  previousContent: string | null,
  nextContent: string | null,
): FileChange {
  const result = buildUnifiedDiff(previousContent, nextContent, path);
  const hasChanges =
    previousContent === null || nextContent === null || previousContent !== nextContent;

  return {
    path,
    diff: result.diff,
    stats: result.stats,
    changeKind: result.kind,
    hasChanges,
  };
}

export async function buildWriteFileChange(path: string, nextContent: string) {
  const previousContent = await readOptionalFile(path);
  return createFileChange(path, previousContent, nextContent);
}

export async function buildEditFileChange(path: string, edits: EditSpec[]) {
  const previousContent = await readFile(path, 'utf8');
  const nextContent = applyEdits(previousContent, edits);
  return createFileChange(path, previousContent, nextContent);
}

export async function previewFileChangesForToolCall(
  toolName: string,
  input: unknown,
): Promise<FileChange[] | undefined> {
  const record = asRecord(input);
  if (!record) return undefined;

  if (toolName === 'write') {
    const path = typeof record.path === 'string' ? record.path : null;
    const content = typeof record.content === 'string' ? record.content : null;
    if (!path || content === null) return undefined;

    try {
      return [await buildWriteFileChange(path, content)];
    } catch {
      return undefined;
    }
  }

  if (toolName === 'edit') {
    const path = typeof record.path === 'string' ? record.path : null;
    const edits = Array.isArray(record.edits) ? record.edits.filter(isEditSpec) : null;
    if (!path || !edits || edits.length === 0) return undefined;

    try {
      return [await buildEditFileChange(path, edits)];
    } catch {
      return undefined;
    }
  }

  return undefined;
}

export function summarizeFileChanges(fileChanges: FileChange[]) {
  const active = fileChanges.filter(fileChange => fileChange.hasChanges);
  const paths = new Set(active.map(fileChange => fileChange.path));

  return {
    fileCount: paths.size,
    added: active.reduce((sum, fileChange) => sum + fileChange.stats.added, 0),
    modified: active.reduce((sum, fileChange) => sum + fileChange.stats.modified, 0),
    removed: active.reduce((sum, fileChange) => sum + fileChange.stats.removed, 0),
  };
}

export function formatDiffStat(stat: DiffStat, options: { showZeros?: boolean } = {}) {
  const { showZeros = false } = options;
  const parts = [
    ['+', stat.added],
    ['~', stat.modified],
    ['-', stat.removed],
  ] as const;

  const text = parts
    .filter(([, value]) => showZeros || value > 0)
    .map(([prefix, value]) => `${prefix}${value}`)
    .join(' ');

  return text || (showZeros ? '+0 ~0 -0' : '');
}

export function describeFileChange(fileChange: FileChange) {
  const statText = formatDiffStat(fileChange.stats);
  if (statText) return statText;
  if (!fileChange.hasChanges) return 'no changes';
  if (fileChange.changeKind === 'created') return 'created';
  if (fileChange.changeKind === 'deleted') return 'deleted';
  return 'modified';
}
