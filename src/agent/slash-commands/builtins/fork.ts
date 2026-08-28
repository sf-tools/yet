import type { SlashCommand } from '../types';

function normalizeTitle(text: string) {
  const normalized = text.trim().replace(/\s+/g, ' ');
  if (!normalized) return undefined;
  return normalized.length <= 80 ? normalized : normalized.slice(0, 80).trimEnd();
}

export const forkSlashCommand: SlashCommand = {
  name: 'fork',
  description: 'Fork the current chat.',
  suggestedInput: '<name>',
  async execute({ forkCurrentSession }, args) {
    await forkCurrentSession(normalizeTitle(args.argsText));
  },
};
