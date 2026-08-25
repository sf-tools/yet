import type { SlashCommand } from '../types';
import { EntryKind } from '@/types';

export const privateSlashCommand: SlashCommand = {
  name: 'private',
  description: 'Make the current shared thread private again.',
  isAvailable: context => context.getCurrentThreadShareState() !== 'private',
  unavailableDetail: () => 'Thread is already private',
  async execute(context, args) {
    if (args.argv.length > 0) throw new Error(`/${args.invocation} does not accept arguments`);

    await context.makeCurrentThreadPrivate();
    context.persistEntry(EntryKind.Meta, 'thread is now private');
    context.showFooterNotice('thread unshared');
  },
};
