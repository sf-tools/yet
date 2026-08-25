import type { SlashCommand } from '../types';
import { EntryKind } from '@/types';

export const shareSlashCommand: SlashCommand = {
  name: 'share',
  description: 'Share the current thread with a public Yet Cloud link.',
  isAvailable: context => context.getCurrentThreadShareState() !== 'shared',
  unavailableDetail: () => 'Thread is already shared',
  async execute(context, args) {
    if (args.argv.length > 0) throw new Error(`/${args.invocation} does not accept arguments`);

    const result = await context.shareCurrentThread();
    context.persistEntry(EntryKind.Meta, `shared thread: ${result.share.url}`);
    context.showFooterNotice('thread shared');
  },
};
