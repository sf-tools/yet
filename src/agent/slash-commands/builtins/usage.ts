import type { AgentUsage } from '@/agent/messages';
import type { OpenAIAuthSummary, OpenAIUsageBucket, OpenAIUsageSnapshot, OpenAIUsageWindow } from '@/auth';
import type { StatusPanelState } from '@/types';
import type { SlashCommand } from '../types';

const LIMIT_BAR_SEGMENTS = 20;

function compactTokens(value: number) {
  const count = Math.max(0, Math.floor(value));
  if (count < 1_000) return String(count);
  const [scaled, suffix] = count >= 1_000_000_000_000
    ? [count / 1_000_000_000_000, 'T']
    : count >= 1_000_000_000
      ? [count / 1_000_000_000, 'B']
      : count >= 1_000_000
        ? [count / 1_000_000, 'M']
        : [count / 1_000, 'K'];
  const precision = scaled < 10 ? 2 : scaled < 100 ? 1 : 0;
  return `${scaled.toFixed(precision).replace(/\.0+$|(?<=\.[0-9])0+$/, '')}${suffix}`;
}

function sameLocalDay(left: Date, right: Date) {
  return left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate();
}

function resetTimestamp(timestamp: number, capturedAt = new Date()) {
  const reset = new Date(timestamp * 1_000);
  if (!Number.isFinite(reset.getTime())) return null;
  const time = `${String(reset.getHours()).padStart(2, '0')}:${String(reset.getMinutes()).padStart(2, '0')}`;
  if (sameLocalDay(reset, capturedAt)) return time;
  const month = reset.toLocaleString('en-US', { month: 'short' });
  return `${time} on ${reset.getDate()} ${month}`;
}

function approximateWindow(minutes: number, expected: number) {
  return minutes >= expected * 0.95 && minutes <= expected * 1.05;
}

function windowName(limitWindow: OpenAIUsageWindow) {
  const minutes = Math.max(0, limitWindow.windowMinutes ?? 0);
  if (approximateWindow(minutes, 5 * 60)) return '5h';
  if (approximateWindow(minutes, 24 * 60)) return 'Daily';
  if (approximateWindow(minutes, 7 * 24 * 60)) return 'Weekly';
  if (approximateWindow(minutes, 30 * 24 * 60)) return 'Monthly';
  if (approximateWindow(minutes, 365 * 24 * 60)) return 'Annual';
  return limitWindow.kind === 'secondary' ? 'Secondary usage' : 'Usage';
}

function limitBar(usedPercent: number) {
  const remaining = Math.max(0, Math.min(100, 100 - usedPercent));
  const filled = Math.min(LIMIT_BAR_SEGMENTS, Math.round(remaining / 100 * LIMIT_BAR_SEGMENTS));
  let bar = '';
  for (let index = 0; index < LIMIT_BAR_SEGMENTS; index += 1)
    bar += index < filled ? '█' : '░';
  return `[${bar}] ${remaining.toFixed(0)}% left`;
}

function windowRow(limitWindow: OpenAIUsageWindow) {
  const reset = limitWindow.resetsAt ? resetTimestamp(limitWindow.resetsAt) : null;
  return {
    label: `${windowName(limitWindow)} limit`,
    value: `${limitBar(limitWindow.usedPercent)}${reset ? ` (resets ${reset})` : ''}`,
  };
}

function displayPlan(plan: string) {
  const normalized = plan.replace(/_/g, ' ').trim();
  if (['team', 'self serve business prolite', 'self serve business usage based'].includes(normalized))
    return 'Business';
  if (['business', 'enterprise cbp automation', 'enterprise cbp usage based', 'enterprise'].includes(normalized))
    return normalized === 'enterprise cbp automation' ? 'Enterprise (Automation)' : 'Enterprise';
  if (normalized === 'prolite') return 'Pro Lite';
  return normalized.replace(/\b\w/g, character => character.toUpperCase());
}

function creditsValue(usage: OpenAIUsageSnapshot) {
  if (!usage.credits) return null;
  if (usage.credits.unlimited) return 'Unlimited';
  if (!usage.credits.hasCredits) return null;
  const balance = Number(usage.credits.balance);
  return Number.isFinite(balance) && balance > 0 ? `${Math.round(balance)} credits` : 'Available';
}

function bucketSection(bucket: OpenAIUsageBucket, multiple: boolean) {
  return {
    title: bucket.name === 'codex' || !multiple ? 'Limits' : bucket.name,
    rows: bucket.windows.map(windowRow),
  };
}

function chatGPTUsagePanel(usage: OpenAIUsageSnapshot, email?: string): StatusPanelState {
  const buckets = usage.buckets.filter(bucket => bucket.windows.length > 0);
  const sections: StatusPanelState['sections'] = [{
    title: 'ChatGPT',
    rows: [
      ...(email ? [{ label: 'Account', value: email }] : []),
      ...(usage.plan ? [{ label: 'Plan', value: displayPlan(usage.plan) }] : []),
    ],
  }];
  let detailsSection: StatusPanelState['sections'][number] | undefined;
  if (buckets.length === 0) {
    detailsSection = { title: 'Limits', rows: [{ label: 'Usage', value: 'not available for this account' }] };
    sections.push(detailsSection);
  } else {
    const bucketSections = buckets.map(bucket => bucketSection(bucket, buckets.length > 1));
    sections.push(...bucketSections);
    detailsSection = bucketSections[buckets.findIndex(bucket => bucket.name === 'codex')] ?? bucketSections[0];
  }
  const credits = creditsValue(usage);
  if (credits) detailsSection?.rows.push({ label: 'Credits', value: credits });
  if (usage.spendLimit && detailsSection) {
    const reset = usage.spendLimit.resetsAt ? resetTimestamp(usage.spendLimit.resetsAt) : null;
    detailsSection.rows.push({
      label: 'Monthly',
      value: `${limitBar(usage.spendLimit.usedPercent)}${reset ? ` (resets ${reset})` : ''} · ${usage.spendLimit.used} of ${usage.spendLimit.limit} credits used`,
    });
  }
  return { title: 'Usage', sections };
}

function apiUsagePanel(usage: AgentUsage): StatusPanelState {
  const cached = Math.max(0, usage.cachedInputTokens);
  const input = Math.max(0, usage.inputTokens - cached);
  const output = Math.max(0, usage.outputTokens);
  const reasoning = Math.max(0, usage.reasoningTokens);
  return {
    title: 'Usage',
    sections: [{
      title: 'This session',
      rows: [
        { label: 'Total', value: compactTokens(input + output) },
        { label: 'Input', value: compactTokens(input) },
        ...(cached > 0 ? [{ label: 'Cached input', value: compactTokens(cached) }] : []),
        { label: 'Output', value: compactTokens(output) },
        ...(reasoning > 0 ? [{ label: 'Reasoning', value: compactTokens(reasoning) }] : []),
      ],
    }],
  };
}

function loadingUsagePanel(auth: OpenAIAuthSummary): StatusPanelState {
  return {
    title: 'Usage',
    sections: [{
      title: 'ChatGPT',
      rows: [
        ...(auth.email ? [{ label: 'Account', value: auth.email }] : []),
        ...(auth.plan ? [{ label: 'Plan', value: displayPlan(auth.plan) }] : []),
        { label: 'Limits', value: 'Loading…' },
      ],
    }],
  };
}

export const usageSlashCommand: SlashCommand = {
  name: 'usage',
  description: 'Show ChatGPT limits or this session\'s API usage.',
  showBusyIndicator: false,
  async execute(context, args) {
    if (args.argv.length > 0) throw new Error(`/${args.invocation} does not accept arguments`);
    const auth = await context.getOpenAIAuthSummary();
    if (auth?.method !== 'oauth') {
      await context.openStatusPanel(apiUsagePanel(context.store.getState().sessionUsage));
      return;
    }
    const panelClosed = context.openStatusPanel(loadingUsagePanel(auth));
    const loaded = context.getOpenAIUsage().then(
      usage => ({ kind: 'loaded' as const, usage }),
      error => ({ kind: 'error' as const, error }),
    );
    const result = await Promise.race([
      loaded,
      panelClosed.then(() => ({ kind: 'closed' as const })),
    ]);
    if (result.kind === 'closed') return;
    if (result.kind === 'error') {
      context.updateStatusPanel({
        title: 'Usage',
        sections: [{
          title: 'ChatGPT',
          rows: [{ label: 'Limits', value: result.error instanceof Error ? result.error.message : String(result.error) }],
        }],
      });
    } else {
      context.updateStatusPanel(result.usage
        ? chatGPTUsagePanel(result.usage, auth.email)
        : apiUsagePanel(context.store.getState().sessionUsage));
    }
    await panelClosed;
  },
};
