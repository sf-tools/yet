import { createThreadGoal, GOAL_USAGE, goalUsageSummary, isGoalUnfinished } from '@/agent/goals';
import { EntryKind, type ThreadGoal } from '@/types';
import type { SlashCommand, SlashCommandContext } from '../types';

function goalStatusAfterEdit(goal: ThreadGoal) {
  if (goal.status === 'complete' || goal.status === 'budget_limited') return 'active' as const;
  return goal.status;
}

function goalNotice(headline: string, goal?: ThreadGoal) {
  return {
    type: 'entry' as const,
    kind: EntryKind.Meta,
    text: goal ? `${headline}\n${goalUsageSummary(goal)}` : headline,
  };
}

async function replaceConfirmed(context: SlashCommandContext, objective: string) {
  const current = context.getGoal();
  if (current && isGoalUnfinished(current)) {
    const selection = await context.requestChoice({
      title: 'Replace goal?',
      detail: `New objective: ${objective}`,
      recommendedValue: 'cancel',
      options: [
        {
          value: 'replace',
          label: 'Replace current goal',
          detail: 'Set the new objective and start it now',
        },
        {
          value: 'cancel',
          label: 'Cancel',
          detail: 'Keep the current goal',
        },
      ],
    });
    if (selection?.value !== 'replace') return;
  }

  const goal = createThreadGoal(objective);
  context.setGoal(goal);
  context.persistEntries([goalNotice('Goal active', goal)]);
}

export const goalSlashCommand: SlashCommand = {
  name: 'goal',
  description: 'Set or view the goal for a long-running task.',
  suggestedInput: '[<objective>|clear|edit|pause|resume]',
  argumentSuggestions: [
    { value: 'clear', detail: 'Clear the current goal.' },
    { value: 'edit', detail: 'Edit the current goal objective.' },
    { value: 'pause', detail: 'Pause automatic goal continuation.' },
    { value: 'resume', detail: 'Resume automatic goal continuation.' },
  ],
  async execute(context, args) {
    const value = args.argsText.trim();
    const current = context.getGoal();

    if (!value) {
      context.persistEntries(current
        ? [{ type: 'goal_summary', goal: { ...current } }]
        : [
            { type: 'plain', text: GOAL_USAGE },
            { type: 'plain', text: 'No goal is currently set.' },
          ]);
      return;
    }

    switch (value.toLowerCase()) {
      case 'clear':
        if (!current) {
          context.persistEntries([goalNotice('No goal to clear')]);
          return;
        }
        context.setGoal(null);
        context.persistEntries([goalNotice('Goal cleared')]);
        return;
      case 'edit': {
        if (!current) {
          context.persistEntries([
            { type: 'plain', text: GOAL_USAGE },
            { type: 'plain', text: 'No goal is currently set.' },
          ]);
          return;
        }
        const objective = await context.requestTextInput({
          title: 'Edit goal',
          detail: 'Type a goal objective and press Enter',
          initialValue: current.objective,
        });
        if (!objective?.trim()) return;
        const goal: ThreadGoal = {
          ...current,
          objective: objective.trim(),
          status: goalStatusAfterEdit(current),
          updatedAt: Date.now(),
        };
        context.setGoal(goal);
        context.persistEntries([goalNotice(goal.status === 'active' ? 'Goal active' : `Goal ${goal.status}`, goal)]);
        return;
      }
      case 'pause':
        if (!current) break;
        context.setGoal({ ...current, status: 'paused', updatedAt: Date.now() });
        context.persistEntries([goalNotice('Goal paused')]);
        return;
      case 'resume':
        if (!current) break;
        context.setGoal({ ...current, status: 'active', updatedAt: Date.now() });
        context.persistEntries([goalNotice('Goal active', { ...current, status: 'active' })]);
        return;
      default:
        await replaceConfirmed(context, value);
        return;
    }

    context.persistEntries([
      { type: 'plain', text: GOAL_USAGE },
      { type: 'plain', text: 'No goal is currently set.' },
    ]);
  },
};
