import chalk from 'chalk';

import type { AgentsOverviewState } from '@/types';
import { formatWorkspacePath, repeat, truncateToWidth } from '@/text';
import { blankLine, line, span } from '../primitives';
import type { Block, RenderContext, Style } from '../types';

type OverviewRow = {
  root: AgentsOverviewState['roots'][number];
  agent: AgentsOverviewState['roots'][number]['agents'][number];
};

type StatusGroup = 'Needs input' | 'Working' | 'Ready' | 'Finished';

const STATUS_ORDER: StatusGroup[] = ['Needs input', 'Working', 'Ready', 'Finished'];

export function agentOverviewStatusGroup(status: string): StatusGroup {
  if (status === 'needs input' || status === 'errored' || status === 'not found') return 'Needs input';
  if (status === 'running' || status === 'pending init') return 'Working';
  if (status === 'interrupted') return 'Ready';
  return 'Finished';
}

function statusGlyph(status: string): { glyph: string; style: Style } {
  const group = agentOverviewStatusGroup(status);
  if (group === 'Needs input') return { glyph: '●', style: chalk.red };
  if (group === 'Working') return { glyph: '●', style: chalk.green };
  if (group === 'Ready') return { glyph: '○', style: chalk.cyan };
  return { glyph: '✓', style: chalk.dim };
}

function rowGroup(row: OverviewRow, grouping: AgentsOverviewState['grouping']) {
  return grouping === 'project'
    ? formatWorkspacePath(row.root.cwd)
    : agentOverviewStatusGroup(row.agent.status);
}

export function filteredAgentOverviewRows(state: AgentsOverviewState): OverviewRow[] {
  const query = state.query.trim().toLowerCase();
  const rows = state.roots.flatMap(root => root.agents.map(agent => ({ root, agent })))
    .filter(({ root, agent }) => !query || [root.title ?? '', root.cwd, agent.path, agent.label]
      .some(value => value.toLowerCase().includes(query)));
  return rows.sort((left, right) => {
    if (state.grouping === 'status') {
      const status = STATUS_ORDER.indexOf(agentOverviewStatusGroup(left.agent.status)) -
        STATUS_ORDER.indexOf(agentOverviewStatusGroup(right.agent.status));
      if (status !== 0) return status;
    } else {
      const project = left.root.cwd.localeCompare(right.root.cwd);
      if (project !== 0) return project;
    }
    const root = (left.root.title ?? '').localeCompare(right.root.title ?? '');
    if (root !== 0) return root;
    return left.agent.path.localeCompare(right.agent.path);
  });
}

function summaryCounts(rows: OverviewRow[]) {
  return rows.reduce((counts, row) => {
    counts[agentOverviewStatusGroup(row.agent.status)] += 1;
    return counts;
  }, { 'Needs input': 0, Working: 0, Ready: 0, Finished: 0 } as Record<StatusGroup, number>);
}

function visibleWindow(rows: OverviewRow[], selectedIndex: number, height: number) {
  const capacity = Math.max(1, height);
  if (rows.length <= capacity) return { rows, start: 0 };
  const start = Math.max(0, Math.min(rows.length - capacity, selectedIndex - capacity + 2));
  return { rows: rows.slice(start, start + capacity), start };
}

export function renderAgentsOverview(state: AgentsOverviewState, ctx: RenderContext): Block {
  const rows = filteredAgentOverviewRows(state);
  const counts = summaryCounts(rows);
  const out: Block = [
    line(span('  '), span('Agent command center', chalk.bold)),
    line(
      span('  '),
      span(`${counts['Needs input']} need input   ${counts.Working} working   ${counts.Ready} ready`, ctx.theme.dimmed),
    ),
    line(span('  '), span(repeat('─', Math.max(1, ctx.width - 4)), ctx.theme.dimmed)),
  ];

  const listHeight = Math.max(3, Math.min(12, ctx.height - 13));
  const visible = visibleWindow(rows, state.selectedIndex, listHeight);
  let previousGroup = '';
  for (const [offset, row] of visible.rows.entries()) {
    const group = rowGroup(row, state.grouping);
    if (group !== previousGroup) {
      if (previousGroup) out.push(blankLine());
      const count = rows.filter(candidate => rowGroup(candidate, state.grouping) === group).length;
      out.push(line(span('  '), span(group, chalk.bold), span(`  ${count}`, ctx.theme.dimmed)));
      previousGroup = group;
    }
    const index = visible.start + offset;
    const selected = index === state.selectedIndex;
    const status = statusGlyph(row.agent.status);
    const label = truncateToWidth(row.agent.label, Math.max(12, ctx.width - 35));
    out.push(line(
      span(selected ? '› ' : '  ', selected ? chalk.cyanBright : ctx.theme.dimmed),
      span(`${status.glyph} `, status.style),
      span(label, selected ? chalk.white : ctx.theme.foreground),
      span(`  ${agentOverviewStatusGroup(row.agent.status)}`, ctx.theme.dimmed),
    ));
  }
  if (rows.length === 0) out.push(blankLine(), line(span('  '), span('No live agents.', ctx.theme.dimmed)));

  const selected = rows[state.selectedIndex];
  if (selected && ctx.width >= 72) {
    out.push(blankLine());
    out.push(line(span('  '), span('Task details', chalk.bold)));
    out.push(line(span('  '), span('Project  ', ctx.theme.dimmed), span(formatWorkspacePath(selected.root.cwd))));
    out.push(line(span('  '), span('Path     ', ctx.theme.dimmed), span(selected.agent.path)));
    out.push(line(span('  '), span('Model    ', ctx.theme.dimmed), span(`${selected.agent.model} ${selected.agent.thinkingMode}`)));
  }

  out.push(blankLine());
  const label = state.mode === 'search'
    ? 'Search › '
    : state.mode === 'rename'
      ? 'Rename › '
      : 'Task › ';
  const placeholder = state.mode === 'browse' && !state.draft
    ? 'type a task or press / to search'
    : '';
  out.push(line(
    span('  '),
    span(label, chalk.cyanBright),
    span(state.draft),
    span(placeholder, ctx.theme.dimmed),
  ));
  out.push(line(
    span('  '),
    span('↑↓ navigate  enter send  / search  g group  n task  r rename  s stop  esc back', ctx.theme.dimmed),
  ));
  return out;
}
