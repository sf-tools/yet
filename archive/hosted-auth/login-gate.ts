import { spawn } from 'node:child_process';
import { stdin, stdout } from 'node:process';
import chalk from 'chalk';
import { makeNoise2D } from 'open-simplex-noise';
import { APP_VERSION } from '@/config';
import { loadYetCloudAuth, saveYetCloudAuth } from './auth-storage';
import { pollDeviceLogin, startDeviceLogin } from './client';

const LOGO = [
  '      ::::::::  :::    ::: :::::::::: ',
  '    :+:    :+: :+:    :+: :+:         ',
  '   +:+        +:+    +:+ +:+          ',
  '  +#+        +#+    +:+ +#++:++#      ',
  ' +#+        +#+    +#+ +#+            ',
  '+#    #+# #+#    #+# #+#             ',
  '########   ########  ##########       ',
];

const ORB_GLYPHS = ' .:-=+*#%@';
const ORB_WIDTH = 16;
const ORB_HEIGHT = 9;
const ORB_Y_ASPECT = 0.5;
const orbNoise = makeNoise2D(42);

function openBrowser(url: string) {
  if (process.platform === 'darwin')
    return spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
  if (process.platform === 'win32')
    return spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  return spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function visibleWidth(text: string) {
  return text.replace(/\u001b\[[0-9;]*m/g, '').length;
}

function centerLines(lines: string[]) {
  const columns = stdout.columns || 100;
  const rows = stdout.rows || 30;
  const topPadding = Math.max(0, Math.floor((rows - lines.length) / 2));
  const blockWidth = lines.reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
  const leftPadding = Math.max(0, Math.floor((columns - blockWidth) / 2));
  const padded = lines.map(line => `${' '.repeat(leftPadding)}${line}`);

  return `${'\n'.repeat(topPadding)}${padded.join('\n')}`;
}

function renderCentered(lines: string[]) {
  if (stdout.isTTY) stdout.write('\u001b[?25l\u001b[2J\u001b[H');
  stdout.write(centerLines(lines));
}

export class YetLoginCancelledError extends Error {
  constructor() {
    super('Login cancelled');
    this.name = 'YetLoginCancelledError';
  }
}

function renderMiniOrbFrame(frameIndex: number) {
  const time = frameIndex * 0.12;
  const cx = ORB_WIDTH / 2;
  const cy = ORB_HEIGHT / 2;
  const rx = Math.max(1, ORB_WIDTH / 2 - 1);
  const ry = Math.max(1, ORB_HEIGHT / (2 * ORB_Y_ASPECT) - 1);
  const radius = Math.min(rx, ry);
  const radiusSquared = radius * radius;
  const rows: string[] = [];

  for (let y = 0; y < ORB_HEIGHT; y += 1) {
    let line = '';
    const dy = (y - cy) * (1 / ORB_Y_ASPECT);
    const dySquared = dy * dy;

    if (dySquared >= radiusSquared) {
      rows.push(' '.repeat(ORB_WIDTH));
      continue;
    }

    const rowRadius = Math.sqrt(radiusSquared - dySquared);
    const start = Math.max(0, Math.floor(cx - rowRadius));
    const end = Math.min(ORB_WIDTH - 1, Math.ceil(cx + rowRadius));

    for (let x = 0; x < ORB_WIDTH; x += 1) {
      if (x < start || x > end) {
        line += ' ';
        continue;
      }

      const dx = x - cx;
      const dist = Math.sqrt(dx * dx + dySquared);
      const norm = dist / radius;
      if (norm >= 1) {
        line += ' ';
        continue;
      }

      const radial = 1 - norm * norm;
      const value = (orbNoise(x / 20, y / 20 + time) + 1) * 0.5 * radial;
      const clamped = Math.max(0.12, Math.min(1, value));
      line +=
        ORB_GLYPHS[Math.min(ORB_GLYPHS.length - 1, Math.floor(clamped * ORB_GLYPHS.length))] || ' ';
    }

    rows.push(line);
  }

  while (rows.length > 0 && rows[0]?.trim().length === 0) rows.shift();
  while (rows.length > 0 && rows[rows.length - 1]?.trim().length === 0) rows.pop();

  return rows;
}

function padLeft(text: string, width: number) {
  return `${' '.repeat(Math.max(0, width - visibleWidth(text)))}${text}`;
}

function renderLoginGate(frameIndex: number, lines: string[]) {
  const orbLines = renderMiniOrbFrame(frameIndex);
  const orbWidth = orbLines.reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
  const logoLineCount = LOGO.length;
  const orbStart = Math.max(0, Math.floor((logoLineCount - orbLines.length) / 2) - 2);

  const combined = lines.map((line, index) => {
    const isFooterLine = index >= logoLineCount + 1;
    if (isFooterLine) return line;

    const orb =
      index >= orbStart && index < orbStart + orbLines.length
        ? (orbLines[index - orbStart] ?? '')
        : '';
    return `${padLeft(orb, orbWidth)}  ${line}`;
  });

  renderCentered(combined);
}

async function withSpinner<T>(render: (frameIndex: number) => void, run: () => Promise<T>) {
  let frameIndex = 0;
  render(frameIndex);

  const timer = setInterval(() => {
    frameIndex += 1;
    render(frameIndex);
  }, 90);
  timer.unref?.();

  try {
    return await run();
  } finally {
    clearInterval(timer);
  }
}

async function waitForAnyKey() {
  if (!stdin.isTTY) return;

  await new Promise<void>((resolve, reject) => {
    const onData = (chunk: Buffer | string) => {
      stdin.off('data', onData);

      try {
        stdin.setRawMode?.(false);
      } catch {}

      try {
        stdin.pause();
      } catch {}

      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (text === '\u0003' || text === '\u001b') {
        reject(new YetLoginCancelledError());
        return;
      }

      resolve();
    };

    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

export async function ensureYetCloudLogin() {
  const existing = await loadYetCloudAuth();
  if (existing) return existing;

  try {
    await withSpinner(
      frameIndex =>
        renderLoginGate(frameIndex, [
          ...LOGO.map(line => chalk.white(line)),
          '',
          chalk.gray(`v${APP_VERSION}`),
          chalk.green('Press any key to log in...'),
        ]),
      () => waitForAnyKey(),
    );

    const flow = await startDeviceLogin();

    try {
      openBrowser(flow.verificationUrl);
    } catch {}

    return await withSpinner(
      frameIndex => {
        renderLoginGate(frameIndex, [
          ...LOGO.map(line => chalk.white(line)),
          '',
          chalk.gray(`v${APP_VERSION}`),
          '',
          chalk.white('Signing in with the browser...'),
          chalk.white("If your browser didn't open, click this link to log in:"),
          '',
          flow.verificationUrl,
        ]);
      },
      async () => {
        const deadline = new Date(flow.expiresAt).getTime();
        while (Date.now() < deadline) {
          const result = await pollDeviceLogin(flow.code);

          if (result.status === 'pending') {
            await sleep(1250);
            continue;
          }

          if (result.status === 'approved') {
            const auth = {
              accessToken: result.accessToken,
              baseUrl: 'https://yet.sf.tools',
              email: result.user.email,
              savedAt: new Date().toISOString(),
              userId: result.user.id,
            };
            await saveYetCloudAuth(auth);
            return auth;
          }

          throw new Error(result.status === 'expired' ? 'Login expired.' : 'Login failed.');
        }

        throw new Error('Login timed out.');
      },
    );
  } finally {
    try {
      if (stdin.isTTY) stdin.setRawMode?.(false);
    } catch {}

    try {
      stdin.pause();
    } catch {}

    if (stdout.isTTY) stdout.write('\u001b[?25h');
  }
}
