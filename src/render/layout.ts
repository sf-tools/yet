import chalk from 'chalk';

import { repeat, widthOf, wrapText } from '@/text';
import { line, rawLine, span } from './primitives';
import { serializeLine, serializeSegments } from './serialize';
import type { Block, Line, Segment, Style, StyledLine } from './types';

export const LEFT_MARGIN = ' ';

type PrefixValue = string | Segment | Segment[];

type PanelOptions = {
  bg: string;
  width: number;
};

function panelBodyLine(entry: Line, { bg, width }: PanelOptions) {
  const content = serializeLine(entry);
  const fill = repeat(' ', Math.max(0, width - widthOf(content) - 2));
  return rawLine(`${LEFT_MARGIN}${chalk.bgHex(bg)(` ${content}${fill} `)}`);
}

function cloneSegment(segment: Segment): Segment {
  return { text: segment.text, style: segment.style };
}

export function normalizePrefix(prefix: PrefixValue): Segment[] {
  if (typeof prefix === 'string') return [span(prefix)];
  if (Array.isArray(prefix)) return prefix.map(cloneSegment);
  return [cloneSegment(prefix)];
}

export function prefixWidth(prefix: PrefixValue) {
  return widthOf(serializeSegments(normalizePrefix(prefix)));
}

export function styleText(text: string, style?: Style) {
  return style ? style(text) : text;
}

export function indent(
  block: Block,
  firstPrefix: PrefixValue,
  restPrefix: PrefixValue = firstPrefix,
): Block {
  return block.map((entry, index) => {
    const prefix = normalizePrefix(index === 0 ? firstPrefix : restPrefix);

    if (entry.type === 'raw') return rawLine(`${serializeSegments(prefix)}${entry.text}`);
    return line(...prefix, ...entry.segments);
  });
}

export function panelize(block: Block, options: PanelOptions): Block {
  return block.map(entry => panelBodyLine(entry, options));
}

export function thinPanelize(block: Block, { bg, width }: PanelOptions): Block {
  const border = chalk.hex(bg);
  return [
    rawLine(`${LEFT_MARGIN}${border(repeat('▄', width))}`),
    ...block.map(entry => panelBodyLine(entry, { bg, width })),
    rawLine(`${LEFT_MARGIN}${border(repeat('▀', width))}`),
  ];
}

export function wrapTextBlock(text: string, width: number, style?: Style): StyledLine[] {
  return wrapText(text, Math.max(1, width)).map(part => line(span(part, style)));
}

export function takeLast(block: Block, maxLines: number): Block {
  if (maxLines <= 0) return [];
  return block.slice(-maxLines);
}

export function blockWidth(block: Block) {
  return block.reduce((max, entry) => Math.max(max, lineWidth(entry)), 0);
}

export function lineWidth(entry: Line) {
  return widthOf(entry.type === 'raw' ? entry.text : serializeSegments(entry.segments));
}
