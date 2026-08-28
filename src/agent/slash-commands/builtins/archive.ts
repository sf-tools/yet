import type { SlashCommand } from '../types';

export const archiveSlashCommand: SlashCommand = {
  name: 'archive',
  description: 'Archive this session and exit.',
  async execute({ archiveCurrentSession, requestChoice }, args) {
    if (args.argv.length > 0) throw new Error(`/${args.invocation} does not accept arguments`);

    const selection = await requestChoice({
      title: 'Archive this session?',
      detail: 'Are you sure? This will archive the current session and exit Yet',
      recommendedValue: 'keep',
      options: [
        {
          value: 'keep',
          label: "No, don't archive",
          detail: 'Return to the current session',
        },
        {
          value: 'archive',
          label: 'Yes, archive and exit',
          detail: 'Archive this session now',
        },
      ],
    });

    if (selection?.value === 'archive') await archiveCurrentSession();
  },
};
