import chalk from 'chalk';

import type { SlashCommand } from '../types';
import { parseToggleMode, resolveToggleMode } from './toggle-mode';

const ARGUMENT_SUGGESTIONS = [
  {
    value: 'on',
    label: 'on',
    detail: 'Enable planning mode (read-only agent tools)',
    labelStyle: chalk.greenBright,
  },
  { value: 'off', label: 'off', detail: 'Disable planning mode', labelStyle: chalk.redBright },
  { value: 'toggle', label: 'toggle', detail: 'Toggle planning mode' },
  { value: 'status', label: 'status', detail: 'Show current planning mode status' },
] as const;

function buildPlanningPrompt(task: string) {
  return [
    'Create a concrete implementation plan for this task.',
    'Stay read-only, focus on options and tradeoffs, and end with a concise step-by-step plan.',
    '',
    task.trim(),
  ].join('\n');
}

export const planningSlashCommand: SlashCommand = {
  name: 'plan',
  description: 'Queue a read-only planning turn, or toggle planning mode.',
  suggestedInput: '[prompt]',
  argumentSuggestions: ARGUMENT_SUGGESTIONS,
  showArgumentSuggestionsOnExactInvocation: true,
  execute({ store, enqueueSubmission, setPlanningMode, showFooterNotice }, args) {
    const text = args.argsText.trim();
    const current = store.getState().planningMode;

    if (args.argv.length > 1) {
      enqueueSubmission(buildPlanningPrompt(text), { planningMode: true });
      showFooterNotice('Queued planning turn · read-only');
      return;
    }

    let mode: ReturnType<typeof parseToggleMode>;
    try {
      mode = parseToggleMode(args.argv[0], args.invocation);
    } catch {
      if (!text) throw new Error(`/${args.invocation} accepts a mode or a prompt`);
      enqueueSubmission(buildPlanningPrompt(text), { planningMode: true });
      showFooterNotice('Queued planning turn · read-only');
      return;
    }

    const next = resolveToggleMode(mode, current);

    if (mode !== 'status') setPlanningMode(next);
    showFooterNotice(
      `Planning mode ${next ? 'enabled' : 'disabled'}${next ? ' · read-only tools' : ''}`,
    );
  },
};
