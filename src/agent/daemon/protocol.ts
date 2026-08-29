import type { AgentStatus } from '../collaboration/status';

export type SharedAgentSnapshot = {
  id: string;
  path: string;
  nickname: string | null;
  status: AgentStatus;
  attention?: boolean;
  model: string;
  thinkingMode: string;
};

export type SharedRootSnapshot = {
  rootId: string;
  title: string | null;
  cwd: string;
  updatedAt: string;
  agents: SharedAgentSnapshot[];
};

export type AgentDaemonCommand =
  | { action: 'dispatch'; rootId: string; agentId: string; message: string }
  | { action: 'stop'; rootId: string; agentId: string }
  | { action: 'rename'; rootId: string; agentId: string; name: string };

export type AgentDaemonInbound =
  | { type: 'register'; snapshot: SharedRootSnapshot }
  | { type: 'update'; snapshot: SharedRootSnapshot }
  | { type: 'list'; requestId: string }
  | { type: 'command'; requestId: string; command: AgentDaemonCommand }
  | { type: 'command_result'; requestId: string; ok: boolean; error?: string };

export type AgentDaemonOutbound =
  | { type: 'registered' }
  | { type: 'list_result'; requestId: string; roots: SharedRootSnapshot[] }
  | { type: 'command'; requestId: string; command: AgentDaemonCommand }
  | { type: 'command_result'; requestId: string; ok: boolean; error?: string };
