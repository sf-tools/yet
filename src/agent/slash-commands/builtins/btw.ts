import type { SlashCommand } from '../types';

export const btwSlashCommand: SlashCommand = {
  name: 'btw',
  description: 'Start a side conversation in an ephemeral fork.',
  suggestedInput: '<question>',
  async execute({ startSideConversation }, args) {
    await startSideConversation(args.argsText.trim() || undefined);
  },
};
