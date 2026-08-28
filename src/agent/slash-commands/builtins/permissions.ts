import {
  formatPermissionMode,
  isPermissionMode,
  PERMISSION_OPTIONS,
} from '@/permissions';
import type { SlashCommand } from '../types';

export const permissionsSlashCommand: SlashCommand = {
  name: 'permissions',
  description: 'Update model permissions.',
  argumentSuggestions: PERMISSION_OPTIONS.map(option => ({
    value: option.value,
    label: option.label,
    detail: option.detail,
  })),
  showArgumentSuggestionsOnExactInvocation: false,
  async execute({ store, requestChoice, setPermissionMode, showFooterNotice }, args) {
    if (args.argv.length > 1) throw new Error('/permissions accepts at most one argument');
    let mode = args.argv[0]?.toLowerCase();

    if (!mode) {
      const selection = await requestChoice({
        title: 'Update Model Permissions',
        detail: 'Choose how Yet handles tool actions.',
        options: PERMISSION_OPTIONS.map(option => ({ ...option })),
        recommendedValue: store.getState().permissionMode,
      });
      if (!selection) return;
      mode = selection.value;
    }

    if (!isPermissionMode(mode)) throw new Error(`invalid permission mode: ${mode}`);
    setPermissionMode(mode);
    showFooterNotice(`Permissions set to ${formatPermissionMode(mode)}`);
  },
};
