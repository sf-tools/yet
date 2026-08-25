import type { SlashCommand } from '../types';

function normalizeTitle(text: string) {
  const normalized = text.trim().replace(/\s+/g, ' ');
  if (!normalized) return '';
  return normalized.length <= 80 ? normalized : normalized.slice(0, 80).trimEnd();
}

export const renameSlashCommand: SlashCommand = {
  name: 'rename',
  description: 'Rename the current chat session.',
  suggestedInput: '<name>',
  execute({ setThreadTitle, showFooterNotice }, args) {
    const title = normalizeTitle(args.argsText);
    if (!title) throw new Error(`/${args.invocation} requires a session name`);

    setThreadTitle(title);
    showFooterNotice(`Session renamed to ${title}`);
  },
};
