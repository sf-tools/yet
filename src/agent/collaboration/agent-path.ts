export const ROOT_AGENT_PATH = '/root';

const TASK_NAME_PATTERN = /^[a-z0-9_]+$/;

export function validateTaskName(taskName: string) {
  if (!TASK_NAME_PATTERN.test(taskName)) {
    throw new Error('task_name must contain only lowercase letters, digits, and underscores');
  }
  return taskName;
}

export function normalizeAgentPath(path: string) {
  const trimmed = path.trim();
  if (!trimmed.startsWith('/')) throw new Error(`agent path must be canonical: ${path}`);
  const segments = trimmed.split('/').filter(Boolean);
  if (segments[0] !== 'root' || segments.some((segment, index) => index > 0 && !TASK_NAME_PATTERN.test(segment))) {
    throw new Error(`invalid agent path: ${path}`);
  }
  return `/${segments.join('/')}`;
}

export function childAgentPath(parent: string, taskName: string) {
  return `${normalizeAgentPath(parent)}/${validateTaskName(taskName)}`;
}

export function parentAgentPath(path: string) {
  const normalized = normalizeAgentPath(path);
  if (normalized === ROOT_AGENT_PATH) return null;
  return normalized.slice(0, normalized.lastIndexOf('/')) || ROOT_AGENT_PATH;
}

export function agentPathName(path: string) {
  const normalized = normalizeAgentPath(path);
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

export function resolveAgentPath(currentPath: string, reference: string) {
  const trimmed = reference.trim();
  if (!trimmed) throw new Error('agent target must be a non-empty string');
  if (trimmed.startsWith('/')) return normalizeAgentPath(trimmed);
  return childAgentPath(currentPath, trimmed);
}

export function agentPathMatchesPrefix(path: string, prefix: string) {
  const normalizedPath = normalizeAgentPath(path);
  const normalizedPrefix = normalizeAgentPath(prefix);
  return normalizedPrefix === ROOT_AGENT_PATH ||
    normalizedPath === normalizedPrefix ||
    normalizedPath.startsWith(`${normalizedPrefix}/`);
}

export function agentPathDepth(path: string) {
  return normalizeAgentPath(path).split('/').length - 2;
}
