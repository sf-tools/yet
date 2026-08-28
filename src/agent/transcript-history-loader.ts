import { renderTranscriptDocument } from '@/render/components/transcript-overlay';
import { blankLine } from '@/render/primitives';
import type { Block, RenderContext } from '@/render/types';
import type { HistoryEntry } from '@/types';

type TranscriptHistoryChunk = {
  start: number;
  end: number;
  document: ReturnType<typeof renderTranscriptDocument>;
};

export class TranscriptHistoryLoader {
  private readonly entries: readonly HistoryEntry[];
  private readonly ctx: RenderContext;
  private chunks: TranscriptHistoryChunk[] = [];
  private nextEnd: number;
  private highlightHistoryIndex: number | null;

  constructor(
    entries: readonly HistoryEntry[],
    ctx: RenderContext,
    highlightHistoryIndex: number | null = null,
  ) {
    this.entries = [...entries];
    this.ctx = ctx;
    this.nextEnd = entries.length;
    this.highlightHistoryIndex = highlightHistoryIndex;
  }

  get done() {
    return this.nextEnd === 0;
  }

  get loadedEntryCount() {
    return this.entries.length - this.nextEnd;
  }

  loadMore(maxEntries: number) {
    if (this.done) return false;
    const end = this.nextEnd;
    const start = Math.max(0, end - Math.max(1, Math.floor(maxEntries)));
    this.chunks.unshift(this.renderChunk(start, end));
    this.nextEnd = start;
    return true;
  }

  setHighlightHistoryIndex(index: number | null) {
    if (index === this.highlightHistoryIndex) return false;
    const previous = this.highlightHistoryIndex;
    this.highlightHistoryIndex = index;

    this.chunks = this.chunks.map(chunk => {
      const containsPrevious = previous !== null && previous >= chunk.start && previous < chunk.end;
      const containsNext = index !== null && index >= chunk.start && index < chunk.end;
      return containsPrevious || containsNext
        ? this.renderChunk(chunk.start, chunk.end)
        : chunk;
    });
    return true;
  }

  contentParts(): Block[] {
    const parts: Block[] = [];
    for (const chunk of this.chunks) {
      if (chunk.document.block.length === 0) continue;
      if (parts.length > 0) parts.push([blankLine()]);
      parts.push(chunk.document.block);
    }
    return parts;
  }

  entryRange(index: number) {
    let offset = 0;
    let renderedChunk = false;

    for (const chunk of this.chunks) {
      if (chunk.document.block.length === 0) continue;
      if (renderedChunk) offset += 1;
      const localRange = chunk.document.entryRanges.get(index - chunk.start);
      if (localRange) {
        return {
          start: offset + localRange.start,
          end: offset + localRange.end,
        };
      }
      offset += chunk.document.block.length;
      renderedChunk = true;
    }
    return undefined;
  }

  private renderChunk(start: number, end: number): TranscriptHistoryChunk {
    const highlight = this.highlightHistoryIndex;
    return {
      start,
      end,
      document: renderTranscriptDocument(
        this.entries.slice(start, end),
        { reasoning: '', assistant: '' },
        this.ctx,
        {
          highlightHistoryIndex:
            highlight !== null && highlight >= start && highlight < end
              ? highlight - start
              : null,
        },
      ),
    };
  }
}
