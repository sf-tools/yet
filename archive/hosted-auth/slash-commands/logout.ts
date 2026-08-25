import { clearYetCloudAuth, loadYetCloudAuth } from '@/cloud/auth-storage';
import { logoutYetCloud } from '@/cloud/client';
import type { SlashCommand } from '../types';
import { EntryKind } from '@/types';

export const logoutSlashCommand: SlashCommand = {
  name: 'logout',
  description: 'Log out from Yet Cloud',
  async execute(context, args) {
    if (args.argv.length > 0) throw new Error('/logout does not accept arguments');

    const auth = await loadYetCloudAuth();
    if (!auth) {
      context.persistEntry(EntryKind.Meta, 'not logged in');
      return;
    }

    try {
      await logoutYetCloud(auth);
    } catch {}

    await clearYetCloudAuth();
    context.persistEntry(EntryKind.Meta, 'logged out');
    context.showFooterNotice('yet cloud disconnected');
    context.cleanup(0);
  },
};
