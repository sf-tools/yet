export const IMAGE_TOKEN_PATTERN = /\[image:([a-f0-9]{8})\]/g;

export type ImageTokenRange = {
  start: number;
  end: number;
  token: string;
  label: string;
};

function pattern() {
  return new RegExp(IMAGE_TOKEN_PATTERN.source, IMAGE_TOKEN_PATTERN.flags);
}

export function imageTokenRanges(value: string | string[]): ImageTokenRange[] {
  const text = Array.isArray(value) ? value.join('') : value;
  const ranges: ImageTokenRange[] = [];
  let imageNumber = 0;

  for (const match of text.matchAll(pattern())) {
    const token = match[0];
    const utf16Start = match.index ?? 0;
    const start = Array.from(text.slice(0, utf16Start)).length;
    const end = start + Array.from(token).length;
    imageNumber += 1;
    ranges.push({ start, end, token, label: `[Image #${imageNumber}]` });
  }

  return ranges;
}

export function displayImageTokens(text: string) {
  let imageNumber = 0;
  return text.replace(pattern(), () => {
    imageNumber += 1;
    return `[Image #${imageNumber}]`;
  });
}

export function extractImageTokens(text: string) {
  return imageTokenRanges(text).map(range => range.token);
}

export function imageTokenRangeAt(
  value: string | string[],
  cursor: number,
  direction: 'backward' | 'forward',
) {
  return imageTokenRanges(value).find(range =>
    direction === 'backward'
      ? cursor > range.start && cursor <= range.end
      : cursor >= range.start && cursor < range.end,
  );
}
