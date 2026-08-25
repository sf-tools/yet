import type { SlashCommand } from '../types';

export const compactSlashCommand: SlashCommand = {
  name: 'compact',
  description: 'Summarize the conversation to reduce context',
  suggestedInput: 'force',
  argumentSuggestions: ['force'],
  async execute({ compactConversation }, args) {
    if (args.argv.length > 1) throw new Error(`/${args.invocation} accepts at most one argument`);
    if (args.argv[0] && args.argv[0] !== 'force')
      throw new Error(`invalid /${args.invocation} argument: ${args.argv[0]}`);

    await compactConversation({ manual: true, force: args.argv[0] === 'force' });
  },
};
