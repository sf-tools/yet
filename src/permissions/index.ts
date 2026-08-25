import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { relative, resolve } from 'node:path';

export type PermissionMode = 'ask' | 'auto' | 'full';
export type ToolPermission = 'workspace' | 'elevated';

export const PERMISSION_OPTIONS = [
  {
    value: 'ask',
    label: 'Ask for approval',
    detail:
      'Yet can read and edit files in the current workspace, and run commands. Approval is required to access the internet or edit other files.',
  },
  {
    value: 'auto',
    label: 'Approve for me',
    detail: 'Only ask for actions detected as potentially unsafe.',
  },
  {
    value: 'full',
    label: 'Full Access',
    detail:
      'Yet can edit files outside this workspace and access the internet without asking for approval. Exercise caution when using.',
  },
] as const;

export function isPermissionMode(value: unknown): value is PermissionMode {
  return value === 'ask' || value === 'auto' || value === 'full';
}

export function formatPermissionMode(mode: PermissionMode) {
  return PERMISSION_OPTIONS.find(option => option.value === mode)?.label ?? mode;
}

export function isWithinWorkspace(path: string, workspaceRoot: string) {
  const rel = relative(resolve(workspaceRoot), resolve(path));
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'));
}

const UNSAFE_COMMAND_PATTERNS = [
  /(^|[;&|]\s*)sudo\b/i,
  /(^|[;&|]\s*)(?:rm|rmdir)\b/i,
  /(^|[;&|]\s*)git\s+(?:reset\s+--hard|clean\s+-[^\s]*f|push\b)/i,
  /(^|[;&|]\s*)(?:dd|mkfs(?:\.[\w-]+)?|diskutil|shutdown|reboot|halt)\b/i,
  /(^|[;&|]\s*)(?:kill|pkill|killall)\b/i,
  /(^|[;&|]\s*)(?:chmod|chown)\b[^\n]*-[^\s]*R/i,
  /(^|[;&|]\s*)(?:curl|wget|ssh|scp|sftp|nc|ncat|telnet)\b/i,
  /(^|[;&|]\s*)git\s+(?:clone|fetch|pull|ls-remote)\b/i,
  /(^|[;&|]\s*)(?:npm|pnpm|yarn|bun|pip|pip3|cargo|go)\s+(?:install|add|get)\b/i,
  /(?:^|[^<])>\s*\/(?!dev\/null\b)/,
];

export function isPotentiallyUnsafeCommand(command: string) {
  return UNSAFE_COMMAND_PATTERNS.some(pattern => pattern.test(command));
}

export function shouldPromptForTool(options: {
  mode: PermissionMode;
  requested: ToolPermission;
  potentiallyUnsafe?: boolean;
}) {
  if (options.mode === 'full') return false;
  if (options.requested === 'elevated') return true;
  return options.mode === 'auto' && options.potentiallyUnsafe === true;
}

export const SANDBOX_EXEC_PATH = '/usr/bin/sandbox-exec';

export async function requireSandboxExec() {
  try {
    await access(SANDBOX_EXEC_PATH, constants.X_OK);
  } catch {
    throw new Error(
      'workspace permissions require /usr/bin/sandbox-exec on this platform; choose Full Access explicitly to run without a sandbox',
    );
  }
}

function quoteSandboxPath(path: string) {
  return path.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

export function createWorkspaceSandboxProfile(
  workspaceRoot: string,
  options: { writable?: boolean } = {},
) {
  const root = quoteSandboxPath(resolve(workspaceRoot));
  return [
    '(version 1)',
    '(deny default)',
    '(allow process*)',
    '(allow signal)',
    '(allow sysctl-read)',
    '(allow mach-lookup)',
    '(allow file-read*)',
    '(allow file-write* (literal "/dev/null"))',
    ...(options.writable === false
      ? []
      : [
          `(allow file-write* (subpath "${root}"))`,
          '(allow file-write* (subpath "/private/tmp"))',
          '(allow file-write* (subpath "/tmp"))',
        ]),
  ].join('\n');
}
