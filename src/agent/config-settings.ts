import type { AgentState, AgentStore } from '@/store';
import type { ConfigPickerState } from '@/types';

type ConfigSetting = {
  id: string;
  label: string;
  detail: string;
  read(state: AgentState): boolean;
  write(store: AgentStore, enabled: boolean): void;
};

export const CONFIG_SETTINGS: readonly ConfigSetting[] = [
  {
    id: 'show-thinking',
    label: 'Show thinking',
    detail: 'Show model reasoning in the conversation.',
    read: state => state.showThinking,
    write: (store, enabled) => store.setShowThinking(enabled),
  },
  {
    id: 'automatic-compaction',
    label: 'Automatic compaction',
    detail: 'Compact conversation history before the context window fills.',
    read: state => state.autoCompactEnabled,
    write: (store, enabled) => store.setAutoCompactEnabled(enabled),
  },
];

export function createConfigPickerState(state: AgentState): ConfigPickerState {
  return {
    title: 'Configuration',
    detail: 'Toggle settings. Changes are saved to preferences.json.',
    selectedIndex: 0,
    items: CONFIG_SETTINGS.map(setting => ({
      id: setting.id,
      label: setting.label,
      detail: setting.detail,
      enabled: setting.read(state),
    })),
  };
}

export function applyConfigPickerState(store: AgentStore, picker: ConfigPickerState) {
  const values = new Map(picker.items.map(item => [item.id, item.enabled]));
  let changed = false;

  for (const setting of CONFIG_SETTINGS) {
    const enabled = values.get(setting.id);
    if (enabled === undefined || enabled === setting.read(store.getState())) continue;
    setting.write(store, enabled);
    changed = true;
  }

  return changed;
}
