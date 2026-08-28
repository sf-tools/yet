import type { SlashCommand } from '../types';

export const configSlashCommand: SlashCommand = {
  name: 'config',
  description: 'Configure Yet settings.',
  showBusyIndicator: false,
  async execute({ openConfigPicker }, args) {
    if (args.argv.length > 0)
      throw new Error(`/${args.invocation} does not accept arguments`);
    await openConfigPicker();
  },
};
