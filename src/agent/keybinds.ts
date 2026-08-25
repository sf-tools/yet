import parseKeypress, { nonAlphanumericKeys } from '@/keypress';

export type InputBinding =
  | { type: 'interrupt' }
  | { type: 'escape' }
  | { type: 'toggleThinkingMode' }
  | { type: 'togglePreviews' }
  | { type: 'acceptSuggestion' }
  | { type: 'submit' }
  | { type: 'moveSuggestion'; delta: number }
  | { type: 'backspace' }
  | { type: 'delete' }
  | { type: 'moveCursor'; delta: number }
  | { type: 'cursorHome' }
  | { type: 'cursorEnd' }
  | { type: 'insertText'; text: string };

type ParsedKeypress = {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  sequence: string;
  isKittyProtocol?: boolean;
  isPrintable?: boolean;
  text?: string;
};

function decodeInput(keypress: ParsedKeypress) {
  let input = '';

  if (keypress.isKittyProtocol) {
    if (keypress.isPrintable) input = keypress.text ?? keypress.name ?? '';
    else if (keypress.ctrl && (keypress.name?.length ?? 0) === 1) input = keypress.name ?? '';
  } else if (keypress.ctrl) {
    input = keypress.name ?? '';
  } else {
    input = keypress.sequence;
  }

  if (!keypress.isKittyProtocol && nonAlphanumericKeys.includes(keypress.name ?? '')) input = '';
  if (input.startsWith('\u001b')) input = input.slice(1);
  return input;
}

export function resolveInputBinding(data: Buffer | string): InputBinding | null {
  const keypress = parseKeypress(data) as ParsedKeypress;
  const input = decodeInput(keypress);

  if (input === 'c' && keypress.ctrl) return { type: 'interrupt' };
  if (keypress.name === 'escape') return { type: 'escape' };
  if (input === 'o' && keypress.ctrl) return { type: 'togglePreviews' };
  if (keypress.name === 'tab' && keypress.shift) return { type: 'toggleThinkingMode' };
  if (keypress.name === 'tab') return { type: 'acceptSuggestion' };
  if (keypress.name === 'return') return { type: 'submit' };
  if (keypress.name === 'up') return { type: 'moveSuggestion', delta: -1 };
  if (keypress.name === 'down') return { type: 'moveSuggestion', delta: 1 };
  if (keypress.name === 'backspace') return { type: 'backspace' };
  if (keypress.name === 'delete') return { type: 'delete' };
  if (keypress.name === 'left') return { type: 'moveCursor', delta: -1 };
  if (keypress.name === 'right') return { type: 'moveCursor', delta: 1 };
  if (keypress.name === 'home') return { type: 'cursorHome' };
  if (keypress.name === 'end') return { type: 'cursorEnd' };
  if (!keypress.ctrl && !keypress.meta && input) return { type: 'insertText', text: input };

  return null;
}
