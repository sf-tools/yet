export const kittyFlags = {
  disambiguateEscapeCodes: 1,
  reportEventTypes: 2,
  reportAlternateKeys: 4,
  reportAllKeysAsEscapeCodes: 8,
  reportAssociatedText: 16,
} as const;

export function resolveFlags(flags: Iterable<KittyFlag>): number {
  let result = 0;
  for (const flag of flags) result |= kittyFlags[flag];
  return result;
}

export const kittyModifiers = {
  shift: 1,
  alt: 2,
  ctrl: 4,
  super: 8,
  hyper: 16,
  meta: 32,
  capsLock: 64,
  numLock: 128,
} as const;

export type KittyModifier = keyof typeof kittyModifiers;
export type KittyFlag = keyof typeof kittyFlags;
