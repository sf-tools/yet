import { isSupportedOpenAIModel } from '@/config';
import type { SlashCommand } from '../types';

export const fastSlashCommand: SlashCommand = {
  name: 'fast',
  description: 'Toggle faster OpenAI processing.',
  isAvailable: context => isSupportedOpenAIModel(context.getCurrentModel()),
  execute({ store, setFastModeEnabled, showFooterNotice }, args) {
    if (args.argv.length > 0) throw new Error(`/${args.invocation} does not accept arguments`);

    const state = store.getState();
    if (!isSupportedOpenAIModel(state.currentModel)) {
      throw new Error(`/${args.invocation} is only available for OpenAI models`);
    }

    const enabled = !state.fastModeEnabled;
    setFastModeEnabled(enabled);
    showFooterNotice(`Fast mode ${enabled ? 'on' : 'off'}`);
  },
};
