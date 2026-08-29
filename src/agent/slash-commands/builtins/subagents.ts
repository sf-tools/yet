import type { SlashCommand } from '../types';

export const subagentsSlashCommand: SlashCommand = {
  name: 'subagents',
  description: "Switch between this session's subagents.",
  showBusyIndicator: false,
  async execute({ openSubagentsPicker }, args) {
    if (args.argv.length > 0) throw new Error(`/${args.invocation} does not accept arguments`);
    await openSubagentsPicker();
  },
};
