import type { SlashCommand } from '../types';

export const logoutSlashCommand: SlashCommand = {
  name: 'logout',
  description: 'Log out of OpenAI.',
  showBusyIndicator: false,
  async execute(context, args) {
    if (args.argv.length > 0) throw new Error(`/${args.invocation} does not accept arguments`);

    const result = await context.logoutOpenAI();
    if (!result.loggedOut) {
      context.showFooterNotice('Not logged in to OpenAI', 3_000);
      return;
    }

    const suffix = result.revocationFailed
      ? ' · remote revocation failed; local credentials were removed'
      : '';
    context.showFooterNotice(`Logged out of OpenAI${suffix}`, 6_000);
  },
};
