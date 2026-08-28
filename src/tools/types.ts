import type {
  BackgroundTerminalExecOptions,
  BackgroundTerminalResult,
} from '@/agent/background-terminals';
import type { ThinkingMode } from '@/config';
import type { PermissionMode, ToolPermission } from '@/permissions';
import type { ApprovalRequest, FileChange, ThreadGoal } from '@/types';

export type JsonSchema = Record<string, unknown>;

export type ToolExecutionResult = {
  output: string;
  fileChanges?: FileChange[];
};

export type FileMutation = {
  path: string;
  previousContent: string | null;
  nextContent: string | null;
};

export type Tool = {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  execute(input: unknown): Promise<ToolExecutionResult>;
};

export type ToolAuthorization = {
  requested: ToolPermission;
  potentiallyUnsafe?: boolean;
};

export type ToolFactoryOptions = {
  workspaceRoot: string;
  getPermissionMode: () => PermissionMode;
  getPlanningMode: () => boolean;
  getThinkingMode: () => ThinkingMode;
  authorize: (request: ApprovalRequest, authorization: ToolAuthorization) => Promise<boolean>;
  execCommand: (
    command: string,
    options: BackgroundTerminalExecOptions,
  ) => Promise<BackgroundTerminalResult>;
  writeStdin: (
    sessionId: number,
    chars?: string,
    options?: { yieldTimeMs?: number; maxOutputTokens?: number },
  ) => Promise<BackgroundTerminalResult>;
  recordFileMutations: (files: FileMutation[]) => void;
  getGoal: () => ThreadGoal | null;
  createGoal: (objective: string, tokenBudget?: number) => ThreadGoal;
  updateGoal: (status: 'complete' | 'blocked') => ThreadGoal;
};

export function asObject(value: unknown, toolName: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${toolName} arguments must be a JSON object`);
  return value as Record<string, unknown>;
}

export function assertOnlyArguments(object: Record<string, unknown>, allowed: string[]) {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(object).filter(key => !allowedSet.has(key));
  if (unexpected.length > 0) throw new Error(`unexpected argument: ${unexpected.join(', ')}`);
}

export function stringArgument(
  object: Record<string, unknown>,
  name: string,
  options: { nonEmpty?: boolean } = {},
) {
  const value = object[name];
  if (typeof value !== 'string' || (options.nonEmpty !== false && value.trim().length === 0))
    throw new Error(`${name} must be a non-empty string`);
  return value;
}

export function permissionArgument(object: Record<string, unknown>): ToolPermission {
  const value = object.permissions;
  if (value === undefined) return 'workspace';
  if (value === 'workspace' || value === 'elevated') return value;
  throw new Error('permissions must be workspace or elevated');
}
