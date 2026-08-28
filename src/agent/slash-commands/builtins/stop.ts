import { EntryKind } from '@/types';
import type { SlashCommand } from '../types';

export const stopSlashCommand: SlashCommand = {
  name: 'stop',
  description: 'Stop all background terminals.',
  execute({ stopBackgroundTerminals, persistEntries }, args) {
    if (args.argv.length > 0) throw new Error('/stop does not accept arguments');
    stopBackgroundTerminals();
    persistEntries([
      {
        type: 'entry',
        kind: EntryKind.Meta,
        text: 'Stopping all background terminals.',
      },
    ]);
  },
};
