export type ClipboardImageBackend = {
  hasImage(): boolean;
  getImageBinary(): Promise<number[]>;
};

export type ClipboardImage = {
  bytes: Uint8Array;
  mediaType: 'image/png';
  originalName: 'clipboard.png';
};

export class ClipboardImageError extends Error {
  constructor(
    readonly kind: 'clipboard-unavailable' | 'no-image' | 'encode-failed',
    message: string,
  ) {
    super(message);
    this.name = 'ClipboardImageError';
  }
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isPng(bytes: Uint8Array) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return bytes.length >= signature.length && signature.every((byte, index) => bytes[index] === byte);
}

async function loadClipboardBackend(): Promise<ClipboardImageBackend> {
  try {
    const clipboard = await import('@mariozechner/clipboard');
    if (typeof clipboard.hasImage !== 'function' || typeof clipboard.getImageBinary !== 'function') {
      throw new Error('the installed clipboard backend does not support images');
    }
    return clipboard;
  } catch (error) {
    throw new ClipboardImageError(
      'clipboard-unavailable',
      `clipboard unavailable: ${errorText(error)}`,
    );
  }
}

export async function readClipboardImage(
  backend?: ClipboardImageBackend,
): Promise<ClipboardImage> {
  const clipboard = backend ?? (await loadClipboardBackend());

  let hasImage: boolean;
  try {
    hasImage = clipboard.hasImage();
  } catch (error) {
    throw new ClipboardImageError(
      'clipboard-unavailable',
      `clipboard unavailable: ${errorText(error)}`,
    );
  }

  if (!hasImage) throw new ClipboardImageError('no-image', 'no image on clipboard');

  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(await clipboard.getImageBinary());
  } catch (error) {
    throw new ClipboardImageError('encode-failed', `could not encode image: ${errorText(error)}`);
  }

  if (!isPng(bytes)) {
    throw new ClipboardImageError('encode-failed', 'could not encode image: invalid PNG data');
  }

  return { bytes, mediaType: 'image/png', originalName: 'clipboard.png' };
}
