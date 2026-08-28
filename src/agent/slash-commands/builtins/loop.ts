import { EntryKind } from '@/types';
import type { SlashCommand } from '../types';

const LOOP_DESCRIPTION =
  'Run a prompt or slash command on a recurring interval (e.g. /loop 5m /foo). Omit the interval to let the model self-pace.';

const TIME_UNIT_MS = {
  s: 1_000,
  m: 60_000,
  h: 60 * 60_000,
  d: 24 * 60 * 60_000,
} as const;

const UNIT_ALIASES: Record<string, keyof typeof TIME_UNIT_MS> = {
  s: 's',
  sec: 's',
  secs: 's',
  second: 's',
  seconds: 's',
  m: 'm',
  min: 'm',
  mins: 'm',
  minute: 'm',
  minutes: 'm',
  h: 'h',
  hr: 'h',
  hrs: 'h',
  hour: 'h',
  hours: 'h',
  d: 'd',
  day: 'd',
  days: 'd',
};

export type ParsedLoopInput = {
  prompt: string;
  intervalMs: number | null;
};

function intervalMilliseconds(amountText: string, unitText: string) {
  const amount = Number(amountText);
  const unit = UNIT_ALIASES[unitText.toLowerCase()];
  if (!unit || !Number.isSafeInteger(amount) || amount <= 0)
    throw new Error('loop interval must be a positive whole number followed by s, m, h, or d');

  const milliseconds = amount * TIME_UNIT_MS[unit];
  if (!Number.isSafeInteger(milliseconds)) throw new Error('loop interval is too large');
  return milliseconds;
}

export function parseLoopInput(input: string): ParsedLoopInput {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('usage: /loop [interval] <prompt>');

  const leading = trimmed.match(/^(\d+)\s*(s|m|h|d)(?:\s+([\s\S]+))?$/i);
  if (leading) {
    const prompt = leading[3]?.trim() ?? '';
    if (!prompt) throw new Error('usage: /loop [interval] <prompt>');
    return {
      prompt,
      intervalMs: intervalMilliseconds(leading[1], leading[2]),
    };
  }

  const trailing = trimmed.match(
    /^([\s\S]+?)\s+every\s+(\d+)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)$/i,
  );
  if (trailing) {
    const prompt = trailing[1].trim();
    if (!prompt) throw new Error('usage: /loop [interval] <prompt>');
    return {
      prompt,
      intervalMs: intervalMilliseconds(trailing[2], trailing[3]),
    };
  }

  return { prompt: trimmed, intervalMs: null };
}

export function formatLoopInterval(intervalMs: number) {
  const units = [
    ['d', TIME_UNIT_MS.d],
    ['h', TIME_UNIT_MS.h],
    ['m', TIME_UNIT_MS.m],
    ['s', TIME_UNIT_MS.s],
  ] as const;
  const exact = units.find(([, milliseconds]) => intervalMs % milliseconds === 0);
  if (exact) return `${intervalMs / exact[1]}${exact[0]}`;
  return `${intervalMs}ms`;
}

function loopSummary(
  loop: { prompt: string; intervalMs: number | null; nextRunAt: number | null },
  headline = 'Loop active',
) {
  const cadence = loop.intervalMs === null
    ? 'model-paced'
    : `every ${formatLoopInterval(loop.intervalMs)}`;
  const nextRun = loop.nextRunAt === null
    ? ''
    : `\nNext run: ${new Date(loop.nextRunAt).toLocaleTimeString()}`;
  return {
    type: 'entry' as const,
    kind: EntryKind.Meta,
    text: `${headline} · ${cadence}\nPrompt: ${loop.prompt}${nextRun}\nUse /loop stop to stop.`,
  };
}

export const loopSlashCommand: SlashCommand = {
  name: 'loop',
  description: LOOP_DESCRIPTION,
  suggestedInput: '[interval] <prompt>',
  argumentSuggestions: [
    { value: 'status', detail: 'Show the active recurring loop.' },
    { value: 'stop', detail: 'Stop the active recurring loop.' },
  ],
  execute(context, args) {
    const input = args.argsText.trim();

    if (input.toLowerCase() === 'status') {
      const active = context.getActiveLoop();
      context.persistEntries(active
        ? [loopSummary(active)]
        : [{ type: 'plain', text: 'No loop is currently active.' }]);
      return;
    }

    if (input.toLowerCase() === 'stop') {
      const stopped = context.stopLoop();
      context.persistEntries([{
        type: 'entry',
        kind: EntryKind.Meta,
        text: stopped ? 'Loop stopped.' : 'No loop is currently active.',
      }]);
      return;
    }

    const parsed = parseLoopInput(input);
    if (parsed.intervalMs === null && parsed.prompt.startsWith('/')) {
      throw new Error(
        'self-paced loops require an agent prompt; add an interval to repeat a slash command (for example, /loop 5m /status)',
      );
    }
    const result = context.startLoop(parsed.prompt, parsed.intervalMs);
    context.persistEntries([
      loopSummary(
        { ...parsed, nextRunAt: null },
        result.replaced ? 'Loop replaced and running now' : 'Loop running now',
      ),
    ]);
  },
};
