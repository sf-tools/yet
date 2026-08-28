import type { SlashCommand } from '../types';

export const psSlashCommand: SlashCommand = {
  name: 'ps',
  description: 'List background terminals.',
  execute({ listBackgroundTerminals, persistEntries }, args) {
    if (args.argv.length > 0) throw new Error('/ps does not accept arguments');
    persistEntries([
      {
        type: 'background_processes',
        processes: listBackgroundTerminals(),
      },
    ]);
  },
};
