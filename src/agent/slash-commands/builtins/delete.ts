import type { SlashCommand } from '../types';

export const deleteSlashCommand: SlashCommand = {
  name: 'delete',
  description: 'Permanently delete this session and exit.',
  async execute({ deleteCurrentSession, requestChoice }, args) {
    if (args.argv.length > 0) throw new Error(`/${args.invocation} does not accept arguments`);

    const selection = await requestChoice({
      title: 'Delete this session?',
      detail: 'Cannot be undone. Subagent threads will also be deleted.',
      recommendedValue: 'keep',
      options: [
        {
          value: 'keep',
          label: 'No, keep this session',
          detail: 'Return to the current session',
        },
        {
          value: 'delete',
          label: 'Yes, delete and exit',
          detail: 'Permanently delete this session now',
        },
      ],
    });

    if (selection?.value === 'delete') await deleteCurrentSession();
  },
};
