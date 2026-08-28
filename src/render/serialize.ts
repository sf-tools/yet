import type { Block, Line, Segment, StyledLine } from './types';

export function serializeSegment(segment: Segment) {
  return segment.style ? segment.style(segment.text) : segment.text;
}

export function serializeSegments(segments: Segment[]) {
  let output = '';
  for (const segment of segments) output += serializeSegment(segment);
  return output;
}

export function serializeStyledLine(line: StyledLine) {
  return serializeSegments(line.segments);
}

export function serializeLine(line: Line) {
  return line.type === 'raw' ? line.text : serializeStyledLine(line);
}

export function serializeBlock(block: Block) {
  return block.map(serializeLine);
}
