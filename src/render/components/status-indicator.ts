import chalk from 'chalk';

import { LEFT_MARGIN } from '../layout';
import { line, span } from '../primitives';

import type { AgentState } from '@/store';
import type { Block, Segment, Style } from '../types';

const SHIMMER_STARTED_AT = Date.now();
const SHIMMER_PADDING = 10;
const SHIMMER_SWEEP_MS = 2_000;
const SHIMMER_BAND_HALF_WIDTH = 5;
const SHIMMER_BASE = { r: 128, g: 128, b: 128 };
const SHIMMER_HIGHLIGHT = { r: 255, g: 255, b: 255 };

function blendChannel(highlight: number, base: number, amount: number) {
  return Math.round(highlight * amount + base * (1 - amount));
}

function shimmerStyle(intensity: number): Style {
  if (chalk.level < 3) {
    if (intensity < 0.2) return chalk.dim;
    if (intensity < 0.6) return text => text;
    return chalk.bold;
  }

  const highlight = Math.max(0, Math.min(1, intensity)) * 0.9;
  const r = blendChannel(SHIMMER_HIGHLIGHT.r, SHIMMER_BASE.r, highlight);
  const g = blendChannel(SHIMMER_HIGHLIGHT.g, SHIMMER_BASE.g, highlight);
  const b = blendChannel(SHIMMER_HIGHLIGHT.b, SHIMMER_BASE.b, highlight);
  return chalk.rgb(r, g, b).bold;
}

function shimmerSegments(text: string, now = Date.now()): Segment[] {
  const chars = Array.from(text);
  if (chars.length === 0) return [];

  const period = chars.length + SHIMMER_PADDING * 2;
  const elapsed = Math.max(0, now - SHIMMER_STARTED_AT);
  const position = Math.floor(((elapsed % SHIMMER_SWEEP_MS) / SHIMMER_SWEEP_MS) * period);

  return chars.map((character, index) => {
    const distance = Math.abs(index + SHIMMER_PADDING - position);
    const intensity =
      distance <= SHIMMER_BAND_HALF_WIDTH
        ? 0.5 * (1 + Math.cos(Math.PI * (distance / SHIMMER_BAND_HALF_WIDTH)))
        : 0;

    return span(character, shimmerStyle(intensity));
  });
}

export function formatElapsedCompact(elapsedSeconds: number) {
  const seconds = Math.max(0, Math.floor(elapsedSeconds));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600)
    return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;

  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  return `${hours}h ${String(minutes).padStart(2, '0')}m ${String(seconds % 60).padStart(2, '0')}s`;
}

export function renderStatusIndicator(
  state: AgentState,
  elapsedMs: number,
  backgroundTerminalCount = 0,
  now = Date.now(),
): Block {
  if (!state.busy || state.pendingApproval || state.pendingChoice || state.configPicker) return [];

  const elapsed = formatElapsedCompact(elapsedMs / 1_000);
  const waiting = Boolean(state.backgroundWaitCommand);
  return [
    line(
      span(LEFT_MARGIN),
      ...shimmerSegments('•', now),
      span(' '),
      ...shimmerSegments(waiting ? 'Waiting for background terminal' : 'Working', now),
      span(` (${elapsed} • esc to interrupt)`, chalk.dim),
      ...(backgroundTerminalCount > 0
        ? [
            span(' · ', chalk.dim),
            span(
              `${backgroundTerminalCount} background terminal${backgroundTerminalCount === 1 ? '' : 's'} running · /ps to view · /stop to close`,
              chalk.dim,
            ),
          ]
        : []),
    ),
    ...(waiting && state.backgroundWaitCommand
      ? [
          line(
            span(LEFT_MARGIN),
            span('  ↳ ', chalk.dim),
            span(state.backgroundWaitCommand, chalk.dim),
          ),
        ]
      : []),
  ];
}
