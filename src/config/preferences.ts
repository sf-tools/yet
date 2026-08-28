import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  DEFAULT_MODEL,
  getSupportedThinkingModes,
  isSupportedOpenAIModel,
  isThinkingMode,
  normalizeOpenAIModelId,
  type ThinkingMode,
} from './models';
import { isPermissionMode, type PermissionMode } from '@/permissions';

export type YetPreferences = {
  model: string;
  reasoning: ThinkingMode;
  fastModeEnabled: boolean;
  permissions: PermissionMode;
  autoCompactEnabled: boolean;
};

export const YET_PREFERENCES_PATH = join(homedir(), '.yet', 'preferences.json');

export function defaultYetPreferences(): YetPreferences {
  return {
    model: DEFAULT_MODEL,
    reasoning: 'auto',
    fastModeEnabled: false,
    permissions: 'ask',
    autoCompactEnabled: true,
  };
}

export function normalizeYetPreferences(value: unknown): YetPreferences {
  const defaults = defaultYetPreferences();
  const candidate = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const requestedModel = normalizeOpenAIModelId(
    typeof candidate.model === 'string' ? candidate.model : defaults.model,
  );
  const model = isSupportedOpenAIModel(requestedModel) ? requestedModel : defaults.model;
  const requestedReasoning = isThinkingMode(candidate.reasoning)
    ? candidate.reasoning
    : defaults.reasoning;
  const supportedModes = getSupportedThinkingModes(model);

  return {
    model,
    reasoning: supportedModes.includes(requestedReasoning) ? requestedReasoning : 'auto',
    fastModeEnabled:
      typeof candidate.fastModeEnabled === 'boolean'
        ? candidate.fastModeEnabled
        : defaults.fastModeEnabled,
    permissions: isPermissionMode(candidate.permissions) ? candidate.permissions : defaults.permissions,
    autoCompactEnabled:
      typeof candidate.autoCompactEnabled === 'boolean'
        ? candidate.autoCompactEnabled
        : defaults.autoCompactEnabled,
  };
}

export async function loadYetPreferences(path = YET_PREFERENCES_PATH): Promise<YetPreferences> {
  try {
    return normalizeYetPreferences(JSON.parse(await readFile(path, 'utf8')));
  } catch {
    return defaultYetPreferences();
  }
}

export async function saveYetPreferences(preferences: YetPreferences, path = YET_PREFERENCES_PATH) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(normalizeYetPreferences(preferences), null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}
