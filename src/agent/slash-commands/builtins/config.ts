import type { SlashCommand } from '../types';

export const configSlashCommand: SlashCommand = {
  name: 'config',
  description: 'Configure Yet settings.',
  async execute({ openConfigPicker }, args) {
    if (args.argv.length > 0)
      throw new Error(`/${args.invocation} does not accept arguments`);
    await openConfigPicker();
  },
};
