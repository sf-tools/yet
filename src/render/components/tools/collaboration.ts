import chalk from 'chalk';

import type { ToolHistoryEntry } from '@/types';
import { LEFT_MARGIN, indent, wrapTextBlock } from '@/render/layout';
import { line, span } from '@/render/primitives';
import type { Block, RenderContext } from '@/render/types';

function objectInput(entry: ToolHistoryEntry) {
  return entry.input && typeof entry.input === 'object' && !Array.isArray(entry.input)
    ? entry.input as Record<string, unknown>
    : {};
}

function outputObject(entry: ToolHistoryEntry) {
  const output = entry.output && typeof entry.output === 'object' && 'output' in entry.output
    ? (entry.output as { output?: unknown }).output
    : entry.output;
  try {
    return typeof output === 'string' ? JSON.parse(output) as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function event(
  title: string,
  target: string | null,
  detail: string | null,
  ctx: RenderContext,
  suffix: string | null = null,
): Block {
  const heading = line(
    span(LEFT_MARGIN),
    span('• ', ctx.theme.dimmed),
    span(title, chalk.bold),
    ...(target ? [span(' '), span(target, value => chalk.cyanBright.bold(value))] : []),
    ...(suffix ? [span(' '), span(suffix, chalk.magenta)] : []),
  );
  if (!detail) return [heading];
  return [
    heading,
    ...indent(
      wrapTextBlock(detail.replace(/\s+/g, ' ').trim(), Math.max(1, ctx.width - 6), ctx.theme.dimmed),
      `${LEFT_MARGIN} └ `,
      `${LEFT_MARGIN}   `,
    ),
  ];
}

export function renderCollaborationTool(entry: ToolHistoryEntry, ctx: RenderContext): Block {
  const input = objectInput(entry);
  const name = entry.toolName.replace(/^collaboration\./, '');
  if (entry.status === 'failed') return event('Agent operation failed', null, entry.errorText ?? null, ctx);

  if (name === 'spawn_agent') {
    if (entry.status === 'running') return [];
    const output = outputObject(entry);
    const target = String(output.nickname ?? output.task_name ?? input.task_name ?? 'agent');
    const requested = [input.model, input.reasoning_effort]
      .filter(value => typeof value === 'string' && value.trim())
      .join(' ');
    return event(
      'Spawned',
      target,
      typeof input.message === 'string' ? input.message : null,
      ctx,
      requested ? `(${requested})` : null,
    );
  }
  if (name === 'send_message' || name === 'followup_task') {
    if (entry.status === 'running') return [];
    return event('Sent input to', String(input.target ?? 'agent'), typeof input.message === 'string' ? input.message : null, ctx);
  }
  if (name === 'wait_agent') {
    return event(entry.status === 'running' ? 'Waiting for agents' : 'Finished waiting', null, null, ctx);
  }
  if (name === 'interrupt_agent') {
    if (entry.status === 'running') return [];
    return event('Interrupted', String(input.target ?? 'agent'), null, ctx);
  }
  if (name === 'list_agents') {
    if (entry.status === 'running') return [];
    return event('Checked subagents', null, null, ctx);
  }
  return event(name.replace(/_/g, ' '), null, null, ctx);
}
