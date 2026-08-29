export const collaborationV2Fixture = {
  namespace: 'collaboration',
  namespaceDescription: 'Tools for spawning and managing sub-agents.',
  tools: [
    { name: 'spawn_agent', required: ['task_name', 'message'], outputRequired: ['task_name'] },
    { name: 'send_message', required: ['target', 'message'], outputRequired: [] },
    { name: 'followup_task', required: ['target', 'message'], outputRequired: [] },
    { name: 'wait_agent', required: [], outputRequired: ['message', 'timed_out'] },
    { name: 'list_agents', required: [], outputRequired: ['agents'] },
    { name: 'interrupt_agent', required: ['target'], outputRequired: ['previous_status'] },
  ],
  statuses: ['pending_init', 'running', 'interrupted', 'shutdown', 'not_found', 'completed', 'errored'],
  defaultForkTurns: 'all',
  defaultWaitMs: 30_000,
  minWaitMs: 10_000,
  maxWaitMs: 3_600_000,
  advertisedConcurrency: 4,
} as const;
