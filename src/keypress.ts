import { kittyModifiers } from './kitty';

const textDecoder = new TextDecoder();
const metaKeyCodeRe = /^(?:\x1b)([a-zA-Z0-9])$/;
const fnKeyRe = /^(?:\x1b+)(O|N|\[|\[\[)(?:(\d+)(?:;(\d+))?([~^$])|(?:1;)?(\d+)?([a-zA-Z]))/;

type KeyEventType = 'press' | 'repeat' | 'release';

export type ParsedKeypress = {
  name: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  sequence: string;
  raw?: string;
  code?: string;
  super?: boolean;
  hyper?: boolean;
  capsLock?: boolean;
  numLock?: boolean;
  eventType?: KeyEventType;
  isKittyProtocol?: boolean;
  isPrintable?: boolean;
  text?: string;
};

const keyName: Record<string, string> = {
  OP: 'f1',
  OQ: 'f2',
  OR: 'f3',
  OS: 'f4',
  '[P': 'f1',
  '[Q': 'f2',
  '[R': 'f3',
  '[S': 'f4',
  '[11~': 'f1',
  '[12~': 'f2',
  '[13~': 'f3',
  '[14~': 'f4',
  '[[A': 'f1',
  '[[B': 'f2',
  '[[C': 'f3',
  '[[D': 'f4',
  '[[E': 'f5',
  '[15~': 'f5',
  '[17~': 'f6',
  '[18~': 'f7',
  '[19~': 'f8',
  '[20~': 'f9',
  '[21~': 'f10',
  '[23~': 'f11',
  '[24~': 'f12',
  '[A': 'up',
  '[B': 'down',
  '[C': 'right',
  '[D': 'left',
  '[E': 'clear',
  '[F': 'end',
  '[H': 'home',
  OA: 'up',
  OB: 'down',
  OC: 'right',
  OD: 'left',
  OE: 'clear',
  OF: 'end',
  OH: 'home',
  '[1~': 'home',
  '[2~': 'insert',
  '[3~': 'delete',
  '[4~': 'end',
  '[5~': 'pageup',
  '[6~': 'pagedown',
  '[[5~': 'pageup',
  '[[6~': 'pagedown',
  '[7~': 'home',
  '[8~': 'end',
  '[a': 'up',
  '[b': 'down',
  '[c': 'right',
  '[d': 'left',
  '[e': 'clear',
  '[2$': 'insert',
  '[3$': 'delete',
  '[5$': 'pageup',
  '[6$': 'pagedown',
  '[7$': 'home',
  '[8$': 'end',
  Oa: 'up',
  Ob: 'down',
  Oc: 'right',
  Od: 'left',
  Oe: 'clear',
  '[2^': 'insert',
  '[3^': 'delete',
  '[5^': 'pageup',
  '[6^': 'pagedown',
  '[7^': 'home',
  '[8^': 'end',
  '[Z': 'tab',
};

export const nonAlphanumericKeys: string[] = [...Object.values(keyName), 'backspace'];

const isShiftKey = (code: string): boolean => {
  return ['[a', '[b', '[c', '[d', '[e', '[2$', '[3$', '[5$', '[6$', '[7$', '[8$', '[Z'].includes(
    code,
  );
};

const isCtrlKey = (code: string): boolean => {
  return ['Oa', 'Ob', 'Oc', 'Od', 'Oe', '[2^', '[3^', '[5^', '[6^', '[7^', '[8^'].includes(code);
};

const kittyKeyRe = /^\x1b\[(\d+)(?:;(\d+)(?::(\d+))?(?:;([\d:]+))?)?u$/;
const kittySpecialKeyRe = /^\x1b\[(\d+);(\d+):(\d+)([A-Za-z~])$/;

const kittySpecialLetterKeys: Record<string, string> = {
  A: 'up',
  B: 'down',
  C: 'right',
  D: 'left',
  E: 'clear',
  F: 'end',
  H: 'home',
  P: 'f1',
  Q: 'f2',
  R: 'f3',
  S: 'f4',
};

const kittySpecialNumberKeys: Record<number, string> = {
  2: 'insert',
  3: 'delete',
  5: 'pageup',
  6: 'pagedown',
  7: 'home',
  8: 'end',
  11: 'f1',
  12: 'f2',
  13: 'f3',
  14: 'f4',
  15: 'f5',
  17: 'f6',
  18: 'f7',
  19: 'f8',
  20: 'f9',
  21: 'f10',
  23: 'f11',
  24: 'f12',
};

const kittyCodepointNames: Record<number, string> = {
  27: 'escape',
  9: 'tab',
  127: 'backspace',
  8: 'backspace',
  57358: 'capslock',
  57359: 'scrolllock',
  57360: 'numlock',
  57361: 'printscreen',
  57362: 'pause',
  57363: 'menu',
  57376: 'f13',
  57377: 'f14',
  57378: 'f15',
  57379: 'f16',
  57380: 'f17',
  57381: 'f18',
  57382: 'f19',
  57383: 'f20',
  57384: 'f21',
  57385: 'f22',
  57386: 'f23',
  57387: 'f24',
  57388: 'f25',
  57389: 'f26',
  57390: 'f27',
  57391: 'f28',
  57392: 'f29',
  57393: 'f30',
  57394: 'f31',
  57395: 'f32',
  57396: 'f33',
  57397: 'f34',
  57398: 'f35',
  57399: 'kp0',
  57400: 'kp1',
  57401: 'kp2',
  57402: 'kp3',
  57403: 'kp4',
  57404: 'kp5',
  57405: 'kp6',
  57406: 'kp7',
  57407: 'kp8',
  57408: 'kp9',
  57409: 'kpdecimal',
  57410: 'kpdivide',
  57411: 'kpmultiply',
  57412: 'kpsubtract',
  57413: 'kpadd',
  57414: 'kpenter',
  57415: 'kpequal',
  57416: 'kpseparator',
  57417: 'kpleft',
  57418: 'kpright',
  57419: 'kpup',
  57420: 'kpdown',
  57421: 'kppageup',
  57422: 'kppagedown',
  57423: 'kphome',
  57424: 'kpend',
  57425: 'kpinsert',
  57426: 'kpdelete',
  57427: 'kpbegin',
  57428: 'mediaplay',
  57429: 'mediapause',
  57430: 'mediaplaypause',
  57431: 'mediareverse',
  57432: 'mediastop',
  57433: 'mediafastforward',
  57434: 'mediarewind',
  57435: 'mediatracknext',
  57436: 'mediatrackprevious',
  57437: 'mediarecord',
  57438: 'lowervolume',
  57439: 'raisevolume',
  57440: 'mutevolume',
  57441: 'leftshift',
  57442: 'leftcontrol',
  57443: 'leftalt',
  57444: 'leftsuper',
  57445: 'lefthyper',
  57446: 'leftmeta',
  57447: 'rightshift',
  57448: 'rightcontrol',
  57449: 'rightalt',
  57450: 'rightsuper',
  57451: 'righthyper',
  57452: 'rightmeta',
  57453: 'isoLevel3Shift',
  57454: 'isoLevel5Shift',
};

const isValidCodepoint = (cp: number): boolean =>
  cp >= 0 && cp <= 0x10_ffff && !(cp >= 0xd8_00 && cp <= 0xdf_ff);
const safeFromCodePoint = (cp: number): string =>
  isValidCodepoint(cp) ? String.fromCodePoint(cp) : '?';

function resolveEventType(value: number): KeyEventType {
  if (value === 3) return 'release';
  if (value === 2) return 'repeat';
  return 'press';
}

function parseKittyModifiers(
  modifiers: number,
): Pick<ParsedKeypress, 'ctrl' | 'shift' | 'meta' | 'super' | 'hyper' | 'capsLock' | 'numLock'> {
  return {
    ctrl: !!(modifiers & kittyModifiers.ctrl),
    shift: !!(modifiers & kittyModifiers.shift),
    meta: !!(modifiers & (kittyModifiers.meta | kittyModifiers.alt)),
    super: !!(modifiers & kittyModifiers.super),
    hyper: !!(modifiers & kittyModifiers.hyper),
    capsLock: !!(modifiers & kittyModifiers.capsLock),
    numLock: !!(modifiers & kittyModifiers.numLock),
  };
}

const parseKittyKeypress = (s: string): ParsedKeypress | null => {
  const match = kittyKeyRe.exec(s);
  if (!match) return null;

  const codepoint = parseInt(match[1], 10);
  const modifiers = match[2] ? Math.max(0, parseInt(match[2], 10) - 1) : 0;
  const eventType = match[3] ? parseInt(match[3], 10) : 1;
  const textField = match[4];

  if (!isValidCodepoint(codepoint)) {
    return null;
  }

  let text: string | undefined;
  if (textField) {
    text = textField
      .split(':')
      .map(cp => safeFromCodePoint(parseInt(cp, 10)))
      .join('');
  }

  let name: string;
  let isPrintable: boolean;
  if (codepoint === 32) {
    name = 'space';
    isPrintable = true;
  } else if (codepoint === 13) {
    name = 'return';
    isPrintable = true;
  } else if (kittyCodepointNames[codepoint]) {
    name = kittyCodepointNames[codepoint];
    isPrintable = false;
  } else if (codepoint >= 1 && codepoint <= 26) {
    name = String.fromCodePoint(codepoint + 96); // 'a' is 97
    isPrintable = false;
  } else {
    name = safeFromCodePoint(codepoint).toLowerCase();
    isPrintable = true;
  }

  if (isPrintable && !text) {
    text = safeFromCodePoint(codepoint);
  }

  return {
    name,
    ...parseKittyModifiers(modifiers),
    eventType: resolveEventType(eventType),
    sequence: s,
    raw: s,
    isKittyProtocol: true,
    isPrintable,
    text,
  };
};

const parseKittySpecialKey = (s: string): ParsedKeypress | null => {
  const match = kittySpecialKeyRe.exec(s);
  if (!match) return null;

  const number = parseInt(match[1], 10);
  const modifiers = Math.max(0, parseInt(match[2], 10) - 1);
  const eventType = parseInt(match[3], 10);
  const terminator = match[4];
  const name =
    terminator === '~' ? kittySpecialNumberKeys[number] : kittySpecialLetterKeys[terminator];

  if (!name) return null;

  return {
    name,
    ...parseKittyModifiers(modifiers),
    eventType: resolveEventType(eventType),
    sequence: s,
    raw: s,
    isKittyProtocol: true,
    isPrintable: false,
  };
};

const parseKeypress = (input: string | Uint8Array = ''): ParsedKeypress => {
  let parts: RegExpExecArray | null;
  let s: string;

  if (input instanceof Uint8Array) {
    if (input[0] !== undefined && input[0] > 127 && input[1] === undefined) {
      const bytes = new Uint8Array(input);
      bytes[0] -= 128;
      s = '\x1b' + textDecoder.decode(bytes);
    } else {
      s = textDecoder.decode(input);
    }
  } else {
    s = input || '';
  }

  const kittyResult = parseKittyKeypress(s);
  if (kittyResult) return kittyResult;

  const kittySpecialResult = parseKittySpecialKey(s);
  if (kittySpecialResult) return kittySpecialResult;

  if (kittyKeyRe.test(s)) {
    return {
      name: '',
      ctrl: false,
      meta: false,
      shift: false,
      sequence: s,
      raw: s,
      isKittyProtocol: true,
      isPrintable: false,
    };
  }

  const key: ParsedKeypress = {
    name: '',
    ctrl: false,
    meta: false,
    shift: false,
    sequence: s,
    raw: s,
  };

  key.sequence = key.sequence || s || key.name;

  if (s === '\r' || s === '\x1b\r') {
    key.raw = undefined;
    key.name = 'return';
    key.meta = s.length === 2;
  } else if (s === '\n') {
    key.name = 'enter';
  } else if (s === '\t') {
    key.name = 'tab';
  } else if (s === '\b' || s === '\x1b\b') {
    key.name = 'backspace';
    key.meta = s.charAt(0) === '\x1b';
  } else if (s === '\x7f' || s === '\x1b\x7f') {
    key.name = 'backspace';
    key.meta = s.charAt(0) === '\x1b';
  } else if (s === '\x1b' || s === '\x1b\x1b') {
    key.name = 'escape';
    key.meta = s.length === 2;
  } else if (s === ' ' || s === '\x1b ') {
    key.name = 'space';
    key.meta = s.length === 2;
  } else if (s.length === 1 && s <= '\x1a') {
    key.name = String.fromCharCode(s.charCodeAt(0) + 'a'.charCodeAt(0) - 1);
    key.ctrl = true;
  } else if (s.length === 1 && s >= '0' && s <= '9') {
    key.name = 'number';
  } else if (s.length === 1 && s >= 'a' && s <= 'z') {
    key.name = s;
  } else if (s.length === 1 && s >= 'A' && s <= 'Z') {
    key.name = s.toLowerCase();
    key.shift = true;
  } else if ((parts = metaKeyCodeRe.exec(s))) {
    key.name = parts[1].toLowerCase();
    key.meta = true;
    key.shift = /^[A-Z]$/.test(parts[1]);
  } else if ((parts = fnKeyRe.exec(s))) {
    if (s[0] === '\u001b' && s[1] === '\u001b') {
      key.meta = true;
    }

    const code = [parts[1], parts[2], parts[4], parts[6]]
      .filter((part): part is string => Boolean(part))
      .join('');
    const modifier = Number(parts[3] ?? parts[5] ?? 1) - 1;

    key.ctrl = !!(modifier & 4);
    key.meta = key.meta || !!(modifier & 10);
    key.shift = !!(modifier & 1);
    key.code = code;
    key.name = keyName[code] ?? '';
    key.shift = isShiftKey(code) || key.shift;
    key.ctrl = isCtrlKey(code) || key.ctrl;
  }

  return key;
};

export default parseKeypress;
