import { access, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { delimiter, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

export type SandboxCommand = {
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  backend: 'none' | 'seatbelt' | 'bubblewrap';
};

export type SandboxCommandOptions = {
  mode: SandboxMode;
  workspaceRoot: string;
  cwd: string;
  shell: string;
  command: string;
  env?: NodeJS.ProcessEnv;
  writableRoots?: string[];
  platform?: NodeJS.Platform;
};

export const SANDBOX_EXEC_PATH = '/usr/bin/sandbox-exec';
const PROTECTED_METADATA_NAMES = ['.git', '.agents', '.codex', '.yet'] as const;

function quoteSandboxPath(path: string) {
  return path.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function uniqueResolvedPaths(paths: string[]) {
  return [...new Set(paths.map(path => resolve(path)))];
}

function shallowRootsFirst(paths: string[]) {
  return [...paths].sort(
    (left, right) =>
      left.split(/[\\/]/).filter(Boolean).length -
      right.split(/[\\/]/).filter(Boolean).length,
  );
}

function writableRootPolicy(path: string) {
  const quoted = quoteSandboxPath(path);
  return [
    `(allow file-write* (subpath "${quoted}"))`,
    `(deny file-write-unlink (require-all (literal "${quoted}") (vnode-type DIRECTORY)))`,
    ...PROTECTED_METADATA_NAMES.flatMap(name => {
      const metadata = quoteSandboxPath(resolve(path, name));
      return [
        `(deny file-write* (literal "${metadata}"))`,
        `(deny file-write* (subpath "${metadata}"))`,
      ];
    }),
  ];
}

/**
 * Build the macOS Seatbelt policy used by Yet's managed sandbox.
 * Reads are unrestricted, matching Codex's local workspace preset. Writes are
 * limited to scratch space and explicit roots; network remains denied because
 * the profile is closed by default and contains no IP socket allowance.
 */
export function createWorkspaceSandboxProfile(
  workspaceRoot: string,
  options: { writable?: boolean; writableRoots?: string[] } = {},
) {
  const writableRoots =
    options.writable === false
      ? []
      : uniqueResolvedPaths([workspaceRoot, ...(options.writableRoots ?? [])]);
  const scratchRoots =
    options.writable === false
      ? []
      : uniqueResolvedPaths(['/tmp', '/private/tmp', '/var/tmp', tmpdir()]);

  return [
    '(version 1)',
    '(deny default)',
    '(allow process-exec)',
    '(allow process-fork)',
    '(allow process-info* (target same-sandbox))',
    '(allow signal (target same-sandbox))',
    '(allow sysctl-read)',
    '(allow sysctl-write (sysctl-name "kern.grade_cputype"))',
    '(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo"))',
    '(allow mach-lookup (global-name "com.apple.PowerManagement.control"))',
    '(allow mach-lookup (global-name "com.apple.cfprefsd.daemon"))',
    '(allow mach-lookup (global-name "com.apple.cfprefsd.agent"))',
    '(allow user-preference-read)',
    '(allow iokit-open (iokit-registry-entry-class "RootDomainUserClient"))',
    '(allow ipc-posix-sem)',
    '(allow pseudo-tty)',
    '(allow file-read*)',
    '(allow file-write-data (require-all (path "/dev/null") (vnode-type CHARACTER-DEVICE)))',
    '(allow file-read* file-write* file-ioctl (literal "/dev/ptmx"))',
    '(allow file-read* file-write* (regex #"^/dev/ttys[0-9]+$"))',
    '(allow file-ioctl (regex #"^/dev/ttys[0-9]+$"))',
    ...scratchRoots.map(path => `(allow file-write* (subpath "${quoteSandboxPath(path)}"))`),
    ...writableRoots.flatMap(writableRootPolicy),
    ...(options.writable === false
      ? [
          `(deny file-write* (literal "${quoteSandboxPath(resolve(workspaceRoot))}"))`,
          `(deny file-write* (subpath "${quoteSandboxPath(resolve(workspaceRoot))}"))`,
        ]
      : []),
  ].join('\n');
}

async function requireExecutable(path: string, message: string) {
  try {
    await access(path, constants.X_OK);
  } catch {
    throw new Error(message);
  }
}

async function findExecutableOnPath(name: string, env: NodeJS.ProcessEnv) {
  for (const directory of (env.PATH ?? '').split(delimiter)) {
    if (!directory) continue;
    const candidate = resolve(directory, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep looking. The first executable on PATH wins, matching Codex.
    }
  }
  return null;
}

async function findBubblewrap(env: NodeJS.ProcessEnv) {
  const system = await findExecutableOnPath('bwrap', env);
  if (system) return system;

  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    env.YET_SANDBOX_BWRAP,
    join(moduleDirectory, 'codex-resources', 'bwrap'),
    join(moduleDirectory, '..', 'codex-resources', 'bwrap'),
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Fall through to the next packaged helper location.
    }
  }
  return null;
}

async function existingPaths(paths: string[]) {
  const existing: string[] = [];
  for (const path of paths) {
    try {
      await lstat(path);
      existing.push(path);
    } catch {
      // A missing protected path does not need a read-only bind.
    }
  }
  return existing;
}

async function prepareBubblewrapCommand(options: SandboxCommandOptions): Promise<SandboxCommand> {
  const env = { ...process.env, ...options.env };
  const bwrap = await findBubblewrap(env);
  if (!bwrap) {
    throw new Error(
      'the Linux workspace sandbox could not find bubblewrap on PATH or a bundled helper; install bwrap with your package manager or choose Full Access explicitly',
    );
  }

  const writableRoots = shallowRootsFirst(
    options.mode === 'workspace-write'
      ? uniqueResolvedPaths([
          options.workspaceRoot,
          '/tmp',
          tmpdir(),
          ...(options.writableRoots ?? []),
        ])
      : [],
  );
  const protectedPaths = await existingPaths(
    writableRoots.flatMap(root => PROTECTED_METADATA_NAMES.map(name => resolve(root, name))),
  );
  const args = [
    '--die-with-parent',
    '--new-session',
    '--ro-bind',
    '/',
    '/',
    '--dev',
    '/dev',
    '--bind-try',
    '/dev/shm',
    '/dev/shm',
    ...writableRoots.flatMap(root => ['--bind', root, root]),
    ...protectedPaths.flatMap(path => ['--ro-bind', path, path]),
    '--unshare-user',
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-net',
    '--proc',
    '/proc',
    '--chdir',
    options.cwd,
    '--cap-drop',
    'ALL',
    '--',
    options.shell,
    '-c',
    options.command,
  ];

  return {
    executable: bwrap,
    args,
    env: { ...env, YET_SANDBOX: 'bubblewrap', YET_SANDBOX_NETWORK_DISABLED: '1' },
    backend: 'bubblewrap',
  };
}

export async function prepareSandboxCommand(
  options: SandboxCommandOptions,
): Promise<SandboxCommand> {
  const platform = options.platform ?? process.platform;
  const env = { ...process.env, ...options.env };
  if (options.mode === 'danger-full-access') {
    return {
      executable: options.shell,
      args: ['-c', options.command],
      env,
      backend: 'none',
    };
  }

  if (platform === 'darwin') {
    await requireExecutable(
      SANDBOX_EXEC_PATH,
      'the macOS workspace sandbox requires /usr/bin/sandbox-exec; choose Full Access explicitly to run without a sandbox',
    );
    return {
      executable: SANDBOX_EXEC_PATH,
      args: [
        '-p',
        createWorkspaceSandboxProfile(options.workspaceRoot, {
          writable: options.mode === 'workspace-write',
          writableRoots: options.writableRoots,
        }),
        '--',
        options.shell,
        '-c',
        options.command,
      ],
      env: { ...env, YET_SANDBOX: 'seatbelt', YET_SANDBOX_NETWORK_DISABLED: '1' },
      backend: 'seatbelt',
    };
  }

  if (platform === 'linux') return await prepareBubblewrapCommand(options);

  if (platform === 'win32') {
    throw new Error(
      'the native Windows sandbox helper is not bundled yet; use WSL2 with bubblewrap or choose Full Access explicitly',
    );
  }

  throw new Error(
    `managed sandboxing is unavailable on ${platform}; choose Full Access explicitly to run without a sandbox`,
  );
}
