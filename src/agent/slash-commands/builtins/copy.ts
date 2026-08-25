import type { SlashCommand } from '../types';

export const copySlashCommand: SlashCommand = {
  name: 'copy',
  description: "Copy the agent's latest response to the clipboard.",
  async execute({ copyToClipboard, getLastAssistantResponse, showFooterNotice }, args) {
    if (args.argv.length > 0) throw new Error(`/${args.invocation} does not accept arguments`);

    const response = getLastAssistantResponse();
    if (!response) throw new Error('no agent response is available yet');

    await copyToClipboard(response);
    showFooterNotice('Last response copied');
  },
};
