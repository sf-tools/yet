import type { SlashCommand } from '../types';

export const exitSlashCommand: SlashCommand = {
  name: 'exit',
  description: 'Exit Yet.',
  execute({ cleanup }, args) {
    if (args.argv.length > 0) throw new Error(`/${args.invocation} does not accept arguments`);
    cleanup(0);
  },
};
