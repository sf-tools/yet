import type { Block, RawLine, Segment, Style, StyledLine } from './types';

export function span(text: string, style?: Style): Segment {
  return { text, style };
}

export function line(...segments: Segment[]): StyledLine {
  return { type: 'styled', segments };
}

export function rawLine(text: string): RawLine {
  return { type: 'raw', text };
}

export function blankLine(): StyledLine {
  return line();
}

export function textLine(text: string, style?: Style): StyledLine {
  return line(span(text, style));
}

export function textBlock(text: string, style?: Style): Block {
  return text.split('\n').map(part => textLine(part, style));
}

export function rawBlock(text: string): Block {
  return text.split('\n').map(part => rawLine(part));
}

export function vstack(...blocks: Block[]): Block {
  return blocks.flat();
}
