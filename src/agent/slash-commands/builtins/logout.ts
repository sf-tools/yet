import type { SlashCommand } from '../types';

export const logoutSlashCommand: SlashCommand = {
  name: 'logout',
  description: 'Log out of OpenAI.',
  showBusyIndicator: false,
  async execute(context, args) {
    if (args.argv.length > 0) throw new Error(`/${args.invocation} does not accept arguments`);

    await context.logoutOpenAI();
    context.cleanup(0);
  },
};
