import chalk from 'chalk';
import approx from 'approximate-number';

import {
  formatThinkingMode,
  getContextWindow,
  getOpenAIModelDisplayName,
  isReasoningCapableOpenAIModel,
} from '@/config';
import { summarizeFileChanges } from '@/file-changes';
import { widthOf } from '@/text';
import { line, span } from '../primitives';
import { LEFT_MARGIN } from '../layout';

import type { AgentState } from '@/store';
import type { Block, RenderContext, Segment, StyledLine } from '../types';

function truncateFromStart(text: string, maxWidth: number) {
  if (maxWidth <= 0) return '';
  if (widthOf(text) <= maxWidth) return text;

  let out = '';
  for (const ch of Array.from(text).reverse()) {
    if (widthOf(`…${ch}${out}`) > maxWidth) break;
    out = `${ch}${out}`;
  }

  return out ? `…${out}` : '…';
}

function segmentsWidth(segments: Segment[]) {
  return segments.reduce((sum, segment) => sum + widthOf(segment.text), 0);
}

function justifyLine(left: Segment[], right: Segment[], width: number) {
  if (right.length === 0) return line(...left);

  const leftWidth = segmentsWidth(left);
  const rightWidth = segmentsWidth(right);
  if (leftWidth + rightWidth + 1 <= width) {
    return line(...left, span(' '.repeat(Math.max(1, width - leftWidth - rightWidth))), ...right);
  }

  const availableLeftWidth = Math.max(1, width - rightWidth - 1);
  const leftText = left.map(segment => segment.text).join('');
  const leftStyle = left[left.length - 1]?.style;
  const fittedLeft = truncateFromStart(leftText, availableLeftWidth);
  const gap = Math.max(1, width - widthOf(fittedLeft) - rightWidth);

  return line(span(fittedLeft, leftStyle), span(' '.repeat(gap)), ...right);
}

function fileChangeSummarySegments(state: AgentState, ctx: RenderContext): Segment[] {
  const fileChanges = state.sessionFileChanges;
  if (!fileChanges || fileChanges.length === 0) return [];

  const summary = summarizeFileChanges(fileChanges);
  if (summary.fileCount === 0) return [];

  return [
    span(
      `${summary.fileCount} file${summary.fileCount === 1 ? '' : 's'} changed`,
      ctx.theme.dimmed,
    ),
    ...(summary.added > 0 ? [span(' '), span(`+${summary.added}`, chalk.greenBright)] : []),
    ...(summary.modified > 0 ? [span(' '), span(`~${summary.modified}`, chalk.yellowBright)] : []),
    ...(summary.removed > 0 ? [span(' '), span(`-${summary.removed}`, chalk.redBright)] : []),
  ];
}

function thinkingModeStyle(mode: AgentState['thinkingMode']) {
  switch (mode) {
    case 'auto':
      return chalk.cyanBright;
    case 'none':
      return chalk.gray;
    case 'low':
      return chalk.greenBright;
    case 'medium':
      return chalk.yellowBright;
    case 'high':
      return chalk.redBright;
    case 'xhigh':
      return chalk.magentaBright;
    case 'max':
      return chalk.redBright.bold;
  }
}

function formatUsageSummary(state: AgentState) {
  const promptTokens = state.busy ? state.livePromptTokens : state.lastPromptTokens;
  const outputTokens = state.busy ? state.liveOutputTokens : state.lastOutputTokens;
  const reasoningTokens = state.busy ? state.liveReasoningTokens : state.lastReasoningTokens;

  const hasUsage = promptTokens > 0 || outputTokens > 0 || reasoningTokens > 0;
  if (!hasUsage) return null;

  const contextWindow = getContextWindow(state.currentModel);
  const input = approx(promptTokens, { capital: false, precision: 2 });
  const output = approx(outputTokens, { capital: false, precision: 2 });
  const context = approx(contextWindow, { capital: false, precision: 2 });
  const pct = contextWindow > 0 ? (promptTokens / contextWindow) * 100 : 0;
  const pctLabel = contextWindow > 0 ? (pct < 1 ? '<1%' : `${Math.round(pct)}%`) : 'n/a';

  return {
    text: `↑${input} ↓${output} / ${context} (${pctLabel})`,
    pct,
  };
}

function contextUsageStyle(pct: number | null | undefined, ctx: RenderContext) {
  if (pct == null || !Number.isFinite(pct)) return ctx.theme.dimmed;
  if (pct >= 97) return chalk.redBright;
  if (pct >= 92) return chalk.hex('#ff9f1a');
  if (pct >= 85) return chalk.yellowBright;
  return ctx.theme.dimmed;
}

function joinFooterParts(...parts: Array<string | null | undefined>) {
  return parts.filter(Boolean).join(' · ');
}

function buildStatsLine(
  state: AgentState,
  ctx: RenderContext,
  footerPrefix: Segment[],
  usage: { text: string; pct: number } | null,
  cost: string,
  autoCompact: string,
) {
  const modelName = getOpenAIModelDisplayName(state.currentModel);
  const statsSegments = [...footerPrefix];
  let hasStats = false;

  const appendStat = (text: string, style = ctx.theme.dimmed) => {
    if (!text) return;
    if (hasStats) statsSegments.push(span(' · ', ctx.theme.subtle));
    statsSegments.push(span(text, style));
    hasStats = true;
  };

  appendStat(usage?.text ?? '', contextUsageStyle(usage?.pct, ctx));
  appendStat(cost);
  appendStat(autoCompact);

  return hasStats
    ? line(
        ...statsSegments,
        span(' · ', ctx.theme.subtle),
        span(modelName, chalk.white),
        ...(isReasoningCapableOpenAIModel(state.currentModel)
          ? [
              span(' · ', ctx.theme.subtle),
              span(formatThinkingMode(state.thinkingMode), thinkingModeStyle(state.thinkingMode)),
            ]
          : []),
      )
    : line(
        ...footerPrefix,
        span(modelName, chalk.white),
        ...(isReasoningCapableOpenAIModel(state.currentModel)
          ? [
              span(' · ', ctx.theme.subtle),
              span(formatThinkingMode(state.thinkingMode), thinkingModeStyle(state.thinkingMode)),
            ]
          : []),
      );
}

function buildModeLine(
  state: AgentState,
  ctx: RenderContext,
  footerPrefix: Segment[],
  queued: string,
  statsLine: StyledLine,
) {
  if (state.pendingApproval) {
    return line(
      ...footerPrefix,
      span(joinFooterParts('Approval required', state.pendingApproval.title, queued), chalk.yellow),
    );
  }

  if (state.pendingChoice) {
    return line(
      ...footerPrefix,
      span(joinFooterParts('Choice required', state.pendingChoice.title, queued), chalk.yellow),
    );
  }

  if (state.compacting) {
    return line(
      ...footerPrefix,
      span(joinFooterParts(`${ctx.commandSpinnerFrame} Compacting...`, queued), chalk.yellow),
    );
  }

  if (state.busy && state.busyStatusText) {
    return line(
      ...footerPrefix,
      span(
        joinFooterParts(`${ctx.commandSpinnerFrame} running ${state.busyStatusText}`, queued),
        chalk.yellow,
      ),
    );
  }

  return statsLine;
}

function buildNoticeLine(state: AgentState, ctx: RenderContext, queued: string) {
  if (state.exitConfirmationPending) {
    return line(span(LEFT_MARGIN), span('Press Ctrl+C again to exit', chalk.redBright));
  }

  if (state.steerRequested) {
    return line(span(LEFT_MARGIN), span(joinFooterParts('Steering…', queued), chalk.yellow));
  }

  if (state.abortRequested) {
    return line(span(LEFT_MARGIN), span(joinFooterParts('Aborting…', queued), chalk.redBright));
  }

  if (state.abortConfirmationPending) {
    return line(span(LEFT_MARGIN), span('Press Esc again to abort', chalk.redBright));
  }

  if (state.footerNotice) {
    return line(span(LEFT_MARGIN), span(state.footerNotice, chalk.hex('#8ab4ff')));
  }

  if (state.busy && !state.busyStatusText) {
    return line(
      span(LEFT_MARGIN),
      span(`${ctx.spinnerFrame} ${ctx.busySpinnerVerb}...`, ctx.theme.spinnerText),
      ...(queued ? [span(' · ', ctx.theme.subtle), span(queued, chalk.yellow)] : []),
    );
  }

  return null;
}

export function renderFooter(state: AgentState, ctx: RenderContext): Block {
  const queued =
    state.queuedSubmissions.length > 0 ? `${state.queuedSubmissions.length} queued` : '';
  const usage = formatUsageSummary(state);
  const cost = state.totalCost > 0 ? `$${state.totalCost.toFixed(4)}` : '';
  const autoCompact = state.autoCompactEnabled ? '' : 'auto-compact off';
  const footerPrefix = [
    span(LEFT_MARGIN),
    ...(state.permissionMode === 'full'
      ? [span('! FULL ACCESS', chalk.bgRedBright.black.bold), span(' ')]
      : state.permissionMode === 'auto'
        ? [span('auto approvals', chalk.yellow), span(' · ', ctx.theme.subtle)]
        : []),
  ];
  const statsLine = buildStatsLine(state, ctx, footerPrefix, usage, cost, autoCompact);
  const modeLine = buildModeLine(state, ctx, footerPrefix, queued, statsLine);

  const leftSegments = [
    span(LEFT_MARGIN),
    span(ctx.cwd, ctx.theme.subtle),
    ...(ctx.gitBranch
      ? [span(' · ', ctx.theme.subtle), span(ctx.gitBranch, ctx.theme.subtle)]
      : []),
    ...(state.planningMode
      ? [span(' · ', ctx.theme.subtle), span('plan mode', chalk.magentaBright)]
      : []),
  ];
  const rightSegments = fileChangeSummarySegments(state, ctx);
  const locationLine = justifyLine(leftSegments, rightSegments, Math.max(1, ctx.width));
  const notice = buildNoticeLine(state, ctx, queued);

  return [line(), modeLine, locationLine, ...(notice ? [line(), notice] : [])];
}
