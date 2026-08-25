import { spawn } from 'node:child_process';

async function writeToCommand(command: string, args: string[], text: string) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'ignore', 'pipe'],
      windowsHide: true,
    });

    let stderr = '';
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(new Error(`${command} timed out`));
    }, 5_000);
    timeout.unref?.();

    child.on('error', error => finish(error));
    child.stderr.on('data', chunk => {
      stderr += String(chunk);
    });
    child.stdin.on('error', error => finish(error));
    child.on('close', code => {
      if (code === 0) {
        finish();
        return;
      }

      finish(new Error(stderr.trim() || `${command} exited with code ${code ?? 1}`));
    });

    child.stdin.end(text);
  });
}

function isMissingCommand(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

export function clipboardTextHelperHint() {
  if (process.platform === 'darwin') return 'pbcopy is required for clipboard support.';
  if (process.platform === 'win32') return 'clip.exe is required for clipboard support.';
  return 'Install wl-clipboard, xclip, or xsel for clipboard support.';
}

export async function copyTextToClipboard(text: string) {
  if (process.platform === 'darwin') {
    try {
      await writeToCommand('/usr/bin/pbcopy', [], text);
    } catch (error) {
      if (isMissingCommand(error)) throw new Error(clipboardTextHelperHint());
      throw error;
    }
    return;
  }

  if (process.platform === 'win32') {
    await writeToCommand('clip.exe', [], text.replace(/\n/g, '\r\n'));
    return;
  }

  for (const [command, args] of [
    ['wl-copy', []],
    ['xclip', ['-selection', 'clipboard']],
    ['xsel', ['--clipboard', '--input']],
  ] as const) {
    try {
      await writeToCommand(command, [...args], text);
      return;
    } catch (error) {
      if (!isMissingCommand(error)) throw error;
    }
  }

  throw new Error(clipboardTextHelperHint());
}
