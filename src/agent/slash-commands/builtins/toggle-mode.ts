export type ToggleMode = 'on' | 'off' | 'toggle' | 'status';

export function parseToggleMode(value: string | undefined, commandName: string): ToggleMode {
  if (!value) return 'toggle';

  switch (value.toLowerCase()) {
    case 'on':
    case 'enable':
    case 'enabled':
    case 'true':
      return 'on';
    case 'off':
    case 'disable':
    case 'disabled':
    case 'false':
      return 'off';
    case 'toggle':
      return 'toggle';
    case 'status':
      return 'status';
    default:
      throw new Error(`invalid /${commandName} mode: ${value}`);
  }
}

export function resolveToggleMode(mode: ToggleMode, current: boolean) {
  if (mode === 'status') return current;
  if (mode === 'toggle') return !current;
  return mode === 'on';
}
