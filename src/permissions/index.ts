import { relative, resolve } from 'node:path';

export {
  SANDBOX_EXEC_PATH,
  createWorkspaceSandboxProfile,
  prepareSandboxCommand,
} from '@/sandbox';
export type { SandboxMode } from '@/sandbox';

export type PermissionMode = 'ask' | 'auto' | 'full';
export type ToolPermission = 'workspace' | 'elevated';
export type ApprovalPolicy = 'untrusted' | 'on-request' | 'never';
export type ApprovalsReviewer = 'user' | 'auto_review';

export type PermissionProfile = {
  sandboxMode: import('@/sandbox').SandboxMode;
  approvalPolicy: ApprovalPolicy;
  approvalsReviewer: ApprovalsReviewer;
};

const PERMISSION_PROFILES: Record<PermissionMode, PermissionProfile> = {
  ask: {
    sandboxMode: 'workspace-write',
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
  },
  auto: {
    sandboxMode: 'workspace-write',
    approvalPolicy: 'on-request',
    approvalsReviewer: 'auto_review',
  },
  full: {
    sandboxMode: 'danger-full-access',
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
  },
};

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

export function resolvePermissionProfile(
  mode: PermissionMode,
  options: { readOnly?: boolean } = {},
): PermissionProfile {
  const profile = PERMISSION_PROFILES[mode];
  return {
    ...profile,
    ...(options.readOnly ? { sandboxMode: 'read-only' as const } : {}),
  };
}

export function isWithinWorkspace(path: string, workspaceRoot: string) {
  const rel = relative(resolve(workspaceRoot), resolve(path));
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'));
}

const PROTECTED_WORKSPACE_METADATA_NAMES = new Set(['.git', '.agents', '.codex', '.yet']);

export function isProtectedWorkspaceMetadataPath(path: string, workspaceRoot: string) {
  const rel = relative(resolve(workspaceRoot), resolve(path));
  if (!rel || rel.startsWith('..')) return false;
  return PROTECTED_WORKSPACE_METADATA_NAMES.has(rel.split(/[\\/]/, 1)[0]);
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
  const profile = resolvePermissionProfile(options.mode);
  if (profile.approvalPolicy === 'never') return false;
  if (options.requested === 'elevated') return true;
  return profile.approvalsReviewer === 'auto_review' && options.potentiallyUnsafe === true;
}
