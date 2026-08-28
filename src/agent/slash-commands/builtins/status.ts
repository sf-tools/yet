import { spawnSync } from 'node:child_process';

import { APP_RELEASE_DATE_ISO, APP_VERSION } from '@/config';
import { resolvePermissionProfile } from '@/permissions';
import type { SlashCommand } from '../types';

function formatRows(rows: Array<[string, string]>) {
  const width = rows.reduce((max, [key]) => Math.max(max, key.length), 0);
  return rows.map(([key, value]) => `${key.padEnd(width)}  ${value}`).join('\n');
}

function antVersion() {
  const result = spawnSync('ant', ['--version-raw'], {
    shell: true,
    timeout: 500,
  });
  const version = String(result.stdout ?? '').trim();
  return version ? `v${version}` : 'n/a';
}

export const statusSlashCommand: SlashCommand = {
  name: 'status',
  description: 'Show runtime, session, model, permission, and tool status.',
  execute(context, args) {
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
    const rows: Array<[string, string]> = [
      ['app', 'Yet'],
      ['version', APP_VERSION],
      ['released', APP_RELEASE_DATE_ISO],
      ['node', process.version],
      ['ant', antVersion()],
      ['platform', `${process.platform} ${process.arch}`],
      ['cwd', process.cwd()],
      ['model', state.currentModel],
      ['effort', state.thinkingMode],
      ['fast', state.fastModeEnabled ? 'on' : 'off'],
      ['permissions', state.permissionMode],
      ['sandbox', permissionProfile.sandboxMode],
      ['approval policy', permissionProfile.approvalPolicy],
      ['reviewer', permissionProfile.approvalsReviewer],
      ['planning', state.planningMode ? 'on' : 'off'],
      ['auto compact', state.autoCompactEnabled ? 'on' : 'off'],
      ['show thinking', state.showThinking ? 'on' : 'off'],
      ['tools', tools || 'none'],
      ['conversation id', context.getSessionId()],
      ['request id', context.getLastRequestId() ?? 'n/a'],
      ['session title', context.getThreadTitle() ?? 'untitled'],
      ...(lineage.side ? [['session kind', 'side conversation'] as [string, string]] : []),
      ...(lineage.parentSessionId
        ? [['forked from', lineage.parentSessionId] as [string, string]]
        : []),
      ...(typeof lineage.forkPoint === 'number'
        ? [['fork point', String(lineage.forkPoint)] as [string, string]]
        : []),
    ];

    context.printEntries([{ type: 'plain', text: formatRows(rows) }]);
  },
};
