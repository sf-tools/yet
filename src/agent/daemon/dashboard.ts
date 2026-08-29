import chalk from 'chalk';

import { resolveInputBinding, splitInputEvents } from '../keybinds';
import { diffScreenRowsSequence, synchronizedTerminalSequence } from '../transient-terminal';
import { formatWorkspacePath, truncateToWidth } from '@/text';
import { listSharedAgents, sendSharedAgentCommand } from './client';
import type { SharedAgentSnapshot, SharedRootSnapshot } from './protocol';

type Row = { root: SharedRootSnapshot; agent: SharedAgentSnapshot; label: string };
type Group = 'Needs input' | 'Working' | 'Ready' | 'Finished';

const GROUPS: Group[] = ['Needs input', 'Working', 'Ready', 'Finished'];

function statusText(status: SharedAgentSnapshot['status']) {
  if (typeof status === 'string') return status.replace('_', ' ');
  return 'completed' in status ? 'completed' : 'errored';
}

function statusGroup(status: SharedAgentSnapshot['status']): Group {
  const value = statusText(status);
  if (value === 'errored' || value === 'not found') return 'Needs input';
  if (value === 'running' || value === 'pending init') return 'Working';
  if (value === 'interrupted') return 'Ready';
  return 'Finished';
}

function rowStatusGroup(agent: SharedAgentSnapshot): Group {
  return agent.attention ? 'Needs input' : statusGroup(agent.status);
}

function statusDot(status: SharedAgentSnapshot['status']) {
  const group = statusGroup(status);
  if (group === 'Needs input') return chalk.red('●');
  if (group === 'Working') return chalk.green('●');
  if (group === 'Ready') return chalk.cyan('○');
  return chalk.dim('✓');
}

function visibleRows(roots: SharedRootSnapshot[], query: string, grouping: 'project' | 'status'): Row[] {
  const normalized = query.trim().toLowerCase();
  return roots.flatMap(root => root.agents.map(agent => ({
    root,
    agent,
    label: agent.path === '/root' ? (root.title ?? 'Untitled session') : agent.path,
  }))).filter(row => !normalized || [row.label, row.root.cwd, row.agent.path]
    .some(value => value.toLowerCase().includes(normalized)))
    .sort((left, right) => {
      if (grouping === 'status') {
        const group = GROUPS.indexOf(rowStatusGroup(left.agent)) - GROUPS.indexOf(rowStatusGroup(right.agent));
        if (group !== 0) return group;
      } else {
        const project = left.root.cwd.localeCompare(right.root.cwd);
        if (project !== 0) return project;
      }
      const root = (left.root.title ?? '').localeCompare(right.root.title ?? '');
      return root || left.agent.path.localeCompare(right.agent.path);
    });
}

export async function runAgentsDashboard() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('yet agents requires an interactive terminal');
  let roots: SharedRootSnapshot[] = [];
  let selected = 0;
  let query = '';
  let grouping: 'project' | 'status' = 'project';
  let mode: 'browse' | 'search' | 'dispatch' | 'rename' = 'browse';
  let draft = '';
  let closed = false;
  let lastLines: string[] = [];

  const render = () => {
    const rows = visibleRows(roots, query, grouping);
    selected = Math.max(0, Math.min(selected, Math.max(0, rows.length - 1)));
    const width = process.stdout.columns || 100;
    const counts = rows.reduce((value, row) => {
      value[rowStatusGroup(row.agent)] += 1;
      return value;
    }, { 'Needs input': 0, Working: 0, Ready: 0, Finished: 0 } as Record<Group, number>);
    const lines = [
      chalk.bold('Agent command center'),
      chalk.dim(`${counts['Needs input']} need input   ${counts.Working} working   ${counts.Ready} ready`),
      chalk.dim('─'.repeat(Math.max(1, width - 1))),
    ];
    let lastGroup = '';
    rows.forEach((row, index) => {
      const group = grouping === 'project' ? formatWorkspacePath(row.root.cwd) : rowStatusGroup(row.agent);
      if (group !== lastGroup) {
        if (lastGroup) lines.push('');
        const count = rows.filter(candidate =>
          (grouping === 'project' ? formatWorkspacePath(candidate.root.cwd) : rowStatusGroup(candidate.agent)) === group,
        ).length;
        lines.push(`${chalk.bold(group)}  ${chalk.dim(String(count))}`);
        lastGroup = group;
      }
      const pointer = index === selected ? chalk.cyanBright('›') : ' ';
      const label = truncateToWidth(row.label, Math.max(12, width - 35));
      lines.push(`${pointer} ${row.agent.attention ? chalk.red('●') : statusDot(row.agent.status)} ${label}  ${chalk.dim(rowStatusGroup(row.agent))}`);
    });
    if (rows.length === 0) lines.push(chalk.dim('  No live agents.'));
    const current = rows[selected];
    if (current && width >= 72) {
      lines.push('', chalk.bold('Task details'));
      lines.push(`${chalk.dim('Project  ')}${formatWorkspacePath(current.root.cwd)}`);
      lines.push(`${chalk.dim('Path     ')}${current.agent.path}`);
      lines.push(`${chalk.dim('Model    ')}${current.agent.model} ${current.agent.thinkingMode}`);
    }
    lines.push('');
    if (mode === 'search') lines.push(`${chalk.cyanBright('Search:')} ${draft}`);
    else if (mode === 'dispatch') lines.push(`${chalk.cyanBright('Task:')} ${draft}`);
    else if (mode === 'rename') lines.push(`${chalk.cyanBright('Rename:')} ${draft}`);
    else lines.push(`${chalk.cyanBright('Task:')} ${chalk.dim(query ? `filter: ${query}` : 'type a task or press / to search')}`);
    lines.push(chalk.dim('↑↓ navigate  enter send  / search  g group  n task  r rename  s stop  esc/q back'));
    const height = Math.max(1, process.stdout.rows || 30);
    const screen = lines.slice(0, height);
    while (screen.length < height) screen.push('');
    const update = diffScreenRowsSequence(lastLines, screen, {
      terminalWidth: Math.max(1, width - 1),
    });
    if (update) process.stdout.write(synchronizedTerminalSequence(update));
    lastLines = screen;
  };
  const refresh = async () => {
    try { roots = await listSharedAgents(); } catch {}
    render();
  };
  let timer: ReturnType<typeof setInterval>;
  const quit = () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write('\u001b[?25h\u001b[?1049l');
  };
  const onData = (data: Buffer) => {
    for (const event of splitInputEvents(data.toString('utf8')).events) {
      const binding = resolveInputBinding(event);
      if (!binding) continue;
      const rows = visibleRows(roots, query, grouping);
      const current = rows[selected];
      if (mode !== 'browse') {
        if (binding.type === 'escape' || binding.type === 'interrupt') {
          mode = 'browse'; draft = ''; render(); continue;
        }
        if (binding.type === 'backspace') { draft = draft.slice(0, -1); render(); continue; }
        if (binding.type === 'insertText') { draft += binding.text; render(); continue; }
        if (binding.type === 'submit') {
          if (mode === 'search') query = draft;
          else if (current && draft.trim()) {
            const command = mode === 'dispatch'
              ? { action: 'dispatch' as const, rootId: current.root.rootId, agentId: current.agent.id, message: draft.trim() }
              : { action: 'rename' as const, rootId: current.root.rootId, agentId: current.agent.id, name: draft.trim() };
            void sendSharedAgentCommand(command).then(refresh);
          }
          mode = 'browse'; draft = ''; render();
        }
        continue;
      }
      if (binding.type === 'interrupt' || binding.type === 'escape' || (binding.type === 'insertText' && binding.text === 'q')) { quit(); return; }
      if (binding.type === 'moveSuggestion') {
        selected = (selected + binding.delta + Math.max(1, rows.length)) % Math.max(1, rows.length);
        render(); continue;
      }
      if (binding.type === 'submit' && current) { mode = 'dispatch'; draft = ''; render(); continue; }
      if (binding.type === 'insertText' && binding.text === '/') { mode = 'search'; draft = query; render(); continue; }
      if (binding.type === 'insertText' && binding.text === 'g') { grouping = grouping === 'project' ? 'status' : 'project'; selected = 0; render(); continue; }
      if (binding.type === 'insertText' && binding.text === 'n') { mode = 'dispatch'; draft = ''; render(); continue; }
      if (binding.type === 'insertText' && binding.text === 'r' && current) { mode = 'rename'; draft = current.label; render(); continue; }
      if (binding.type === 'insertText' && binding.text === 's' && current) {
        void sendSharedAgentCommand({ action: 'stop', rootId: current.root.rootId, agentId: current.agent.id }).then(refresh);
        continue;
      }
      if (binding.type === 'insertText') { mode = 'dispatch'; draft = binding.text; render(); }
    }
  };

  process.stdout.write('\u001b[?1049h\u001b[?25l');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', onData);
  timer = setInterval(refresh, 1_000);
  await refresh();
  await new Promise<void>(resolve => {
    const poll = setInterval(() => {
      if (!closed) return;
      clearInterval(poll);
      resolve();
    }, 50);
  });
  process.stdin.off('data', onData);
}
