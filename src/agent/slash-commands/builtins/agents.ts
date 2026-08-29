import type { SlashCommand } from '../types';

export const agentsSlashCommand: SlashCommand = {
  name: 'agents',
  description: 'Open the cross-session agent command center.',
  showBusyIndicator: false,
  async execute({ openAgentsOverview }, args) {
    if (args.argv.length > 0) throw new Error(`/${args.invocation} does not accept arguments`);
    await openAgentsOverview();
  },
};
