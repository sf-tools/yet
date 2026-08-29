import { APP_RELEASE_DATE_ISO, APP_VERSION } from '@/config';
import { resolvePermissionProfile } from '@/permissions';
import type { SlashCommand } from '../types';

function antVersion() {
  const ant = (globalThis as typeof globalThis & { Ant?: { version?: string } }).Ant;
  return typeof ant === 'object' && typeof ant.version === 'string'
    ? ant.version.trim() || null
    : null;
}

export const statusSlashCommand: SlashCommand = {
  name: 'status',
  description: 'Show runtime, session, model, permission, and tool status.',
  showBusyIndicator: false,
  async execute(context, args) {
    if (args.argv.length > 0) throw new Error(`/${args.invocation} does not accept arguments`);

    const state = context.store.getState();
    const tools = context
      .getActiveToolSummaries()
      .flatMap(tool => tool.names)
      .join(', ');
    const lineage = context.getSessionLineage();
    const permissionProfile = resolvePermissionProfile(state.permissionMode, {
      readOnly: state.planningMode,
    });
    const runtimeAntVersion = antVersion();
    const auth = await context.getOpenAIAuthSummary();
    const authLabel = auth?.method === 'oauth'
      ? `ChatGPT${auth.email ? ` · ${auth.email}` : auth.plan ? ` · ${auth.plan}` : ''}`
      : auth?.method === 'api-key'
        ? 'API key'
        : 'not logged in';
    await context.openStatusPanel({
      title: 'Yet status',
      sections: [
          {
            title: 'Runtime',
            rows: [
              { label: 'Yet', value: APP_VERSION },
              { label: 'Released', value: APP_RELEASE_DATE_ISO },
              ...(runtimeAntVersion ? [{ label: 'Ant', value: runtimeAntVersion }] : []),
              { label: 'Platform', value: `${process.platform} ${process.arch}` },
              { label: 'Folder', value: process.cwd() },
            ],
          },
          {
            title: 'Agent',
            rows: [
              { label: 'Model', value: state.currentModel },
              { label: 'OpenAI', value: authLabel },
              { label: 'Effort', value: state.thinkingMode },
              { label: 'Fast mode', value: state.fastModeEnabled ? 'on' : 'off' },
              { label: 'Permissions', value: state.permissionMode },
              { label: 'Sandbox', value: permissionProfile.sandboxMode },
              { label: 'Approvals', value: permissionProfile.approvalPolicy },
              { label: 'Reviewer', value: permissionProfile.approvalsReviewer },
              { label: 'Planning', value: state.planningMode ? 'on' : 'off' },
              { label: 'Tools', value: tools || 'none' },
            ],
          },
          {
            title: 'Session',
            rows: [
              { label: 'Title', value: context.getThreadTitle() ?? 'untitled' },
              { label: 'ID', value: context.getSessionId() },
              { label: 'Request', value: context.getLastRequestId() ?? 'n/a' },
              ...(lineage.side
                ? [{ label: 'Kind', value: 'side conversation' }]
                : []),
              ...(lineage.parentSessionId
                ? [{ label: 'Forked from', value: lineage.parentSessionId }]
                : []),
              ...(typeof lineage.forkPoint === 'number'
                ? [{ label: 'Fork point', value: String(lineage.forkPoint) }]
                : []),
              {
                label: 'Behavior',
                value: `auto compact ${state.autoCompactEnabled ? 'on' : 'off'} · thinking ${state.showThinking ? 'on' : 'off'}`,
              },
            ],
          },
      ],
    });
  },
};
