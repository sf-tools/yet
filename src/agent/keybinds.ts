import parseKeypress, { nonAlphanumericKeys } from '@/keypress';

export type InputBinding =
  | { type: 'interrupt' }
  | { type: 'pasteImage' }
  | { type: 'escape' }
  | { type: 'toggleSideConversation' }
  | { type: 'toggleTranscript' }
  | { type: 'toggleThinkingMode' }
  | { type: 'cycleAgent'; delta: -1 | 1; wordMotionFallback?: true }
  | { type: 'pageTranscript'; delta: number }
  | { type: 'halfPageTranscript'; delta: number }
  | { type: 'acceptSuggestion' }
  | { type: 'editQueuedSubmission'; fallback: 'up' | 'left' }
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
  eventType?: 'press' | 'repeat' | 'release';
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

  if (
    input.toLowerCase() === 'v' &&
    (keypress.ctrl || keypress.meta) &&
    (keypress.eventType === undefined || keypress.eventType === 'press')
  ) {
    return { type: 'pasteImage' };
  }
  if (input === 'c' && keypress.ctrl) return { type: 'interrupt' };
  if (keypress.name === 'escape') return { type: 'escape' };
  if (keypress.name === 'left' && keypress.meta)
    return { type: 'cycleAgent', delta: -1, wordMotionFallback: true };
  if (keypress.name === 'right' && keypress.meta)
    return { type: 'cycleAgent', delta: 1, wordMotionFallback: true };
  if (keypress.meta && input.toLowerCase() === 'b')
    return { type: 'cycleAgent', delta: -1, wordMotionFallback: true };
  if (keypress.meta && input.toLowerCase() === 'f')
    return { type: 'cycleAgent', delta: 1, wordMotionFallback: true };
  if (keypress.sequence === '\u001f' || (input === '/' && keypress.ctrl))
    return { type: 'toggleSideConversation' };
  if (input === 't' && keypress.ctrl) return { type: 'toggleTranscript' };
  if (input === 'b' && keypress.ctrl) return { type: 'pageTranscript', delta: 1 };
  if (input === 'f' && keypress.ctrl) return { type: 'pageTranscript', delta: -1 };
  if (input === 'u' && keypress.ctrl) return { type: 'halfPageTranscript', delta: 1 };
  if (input === 'd' && keypress.ctrl) return { type: 'halfPageTranscript', delta: -1 };
  if (keypress.name === 'pageup') return { type: 'pageTranscript', delta: 1 };
  if (keypress.name === 'pagedown') return { type: 'pageTranscript', delta: -1 };
  if (keypress.name === 'space' && keypress.shift) return { type: 'pageTranscript', delta: 1 };
  if (keypress.name === 'tab' && keypress.shift) return { type: 'toggleThinkingMode' };
  if (keypress.name === 'tab') return { type: 'acceptSuggestion' };
  if (keypress.name === 'return') return { type: 'submit' };
  if (keypress.name === 'up' && keypress.meta)
    return { type: 'editQueuedSubmission', fallback: 'up' };
  if (keypress.name === 'left' && keypress.shift)
    return { type: 'editQueuedSubmission', fallback: 'left' };
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

export function splitInputEvents(text: string): { events: string[]; remainder: string } {
  const events: string[] = [];
  let offset = 0;

  while (offset < text.length) {
    const code = text.charCodeAt(offset);

    if (code === 0x1b) {
      if (offset + 1 >= text.length) {
        events.push(text[offset]);
        offset += 1;
        continue;
      }

      const introducer = text[offset + 1];
      if (introducer === '\u001b') {
        events.push(text[offset]);
        offset += 1;
        continue;
      }
      if (introducer === '[' || introducer === 'O' || introducer === 'N') {
        let end = offset + 2;
        if (introducer === '[' && text[end] === '[') end += 1;
        while (end < text.length) {
          const finalCode = text.charCodeAt(end);
          if (finalCode >= 0x40 && finalCode <= 0x7e) break;
          end += 1;
        }
        if (end >= text.length) break;
        events.push(text.slice(offset, end + 1));
        offset = end + 1;
        continue;
      }

      events.push(text.slice(offset, offset + 2));
      offset += 2;
      continue;
    }

    if (code < 0x20 || code === 0x7f) {
      events.push(text[offset]);
      offset += 1;
      continue;
    }

    let end = offset + 1;
    while (end < text.length) {
      const nextCode = text.charCodeAt(end);
      if (nextCode === 0x1b || nextCode < 0x20 || nextCode === 0x7f) break;
      end += 1;
    }
    events.push(text.slice(offset, end));
    offset = end;
  }

  return { events, remainder: text.slice(offset) };
}
