export type AgentStatus =
  | 'pending_init'
  | 'running'
  | 'interrupted'
  | 'shutdown'
  | 'not_found'
  | { completed: string | null }
  | { errored: string };

export function isFinalAgentStatus(status: AgentStatus) {
  return typeof status === 'object' || status === 'shutdown' || status === 'not_found';
}

export function agentStatusLabel(status: AgentStatus) {
  if (typeof status === 'object') {
    if ('completed' in status) return 'completed';
    return 'errored';
  }
  return status;
}

export function cloneAgentStatus(status: AgentStatus): AgentStatus {
  return typeof status === 'string' ? status : { ...status };
}
