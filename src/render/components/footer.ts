import chalk from 'chalk';

import {
  formatThinkingMode,
  getContextWindow,
  getOpenAIModelDisplayName,
  isReasoningCapableOpenAIModel,
  isSupportedOpenAIModel,
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

function formatContextLeft(state: AgentState) {
  const contextWindow = getContextWindow(state.currentModel);
  if (contextWindow <= 0) return null;
  const usedTokens = state.busy ? state.livePromptTokens : state.lastPromptTokens;
  const remaining = Math.max(0, Math.min(100, 100 - (usedTokens / contextWindow) * 100));
  return `${Math.round(remaining)}% context left`;
}

function joinFooterParts(...parts: Array<string | null | undefined>) {
  return parts.filter(Boolean).join(' · ');
}

function buildStatsLine(
  state: AgentState,
  ctx: RenderContext,
  footerPrefix: Segment[],
  cost: string,
  autoCompact: string,
) {
  const modelName = getOpenAIModelDisplayName(state.currentModel);
  const statsSegments = [
    ...footerPrefix,
    span(modelName, chalk.white),
    ...(isReasoningCapableOpenAIModel(state.currentModel)
      ? [span(' '), span(formatThinkingMode(state.thinkingMode), thinkingModeStyle(state.thinkingMode))]
      : []),
    ...(isSupportedOpenAIModel(state.currentModel) && state.fastModeEnabled
      ? [span(' '), span('fast', chalk.hex('#ff9f1a').italic)]
      : []),
  ];

  const appendStat = (text: string, style = ctx.theme.dimmed) => {
    if (!text) return;
    statsSegments.push(span(' · ', ctx.theme.subtle));
    statsSegments.push(span(text, style));
  };

  appendStat(cost);
  appendStat(autoCompact);

  return line(...statsSegments);
}

function buildModeLine(
  state: AgentState,
  footerPrefix: Segment[],
  statsLine: StyledLine,
) {
  if (state.pendingApproval) {
    return line(
      ...footerPrefix,
      span(joinFooterParts('Approval required', state.pendingApproval.title), chalk.yellow),
    );
  }

  if (state.pendingChoice) {
    return line(
      ...footerPrefix,
      span(joinFooterParts('Choice required', state.pendingChoice.title), chalk.yellow),
    );
  }

  if (state.compacting) {
    return line(
      ...footerPrefix,
      span('Compacting...', chalk.yellow),
    );
  }

  if (state.busy && state.busyStatusText) {
    return line(
      ...footerPrefix,
      span(`running ${state.busyStatusText}`, chalk.yellow),
    );
  }

  return statsLine;
}

function buildNoticeLine(state: AgentState, ctx: RenderContext) {
  if (state.abortRequested) {
    return line(span(LEFT_MARGIN), span('Aborting…', chalk.redBright));
  }

  if (state.footerNotice) {
    return line(span(LEFT_MARGIN), span(state.footerNotice, chalk.hex('#8ab4ff')));
  }

  return null;
}

export function renderFooter(state: AgentState, ctx: RenderContext): Block {
  if (state.busy && state.inputChars.length > 0) {
    const contextLeft = formatContextLeft(state);
    return [
      justifyLine(
        [span(LEFT_MARGIN), span('tab to queue message', ctx.theme.dimmed)],
        contextLeft ? [span(contextLeft, ctx.theme.dimmed)] : [],
        Math.max(1, ctx.width),
      ),
    ];
  }

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
  const statsLine = buildStatsLine(state, ctx, footerPrefix, cost, autoCompact);
  const modeLine = buildModeLine(state, footerPrefix, statsLine);

  const locationSegments = [
    span(LEFT_MARGIN),
    span(ctx.cwd, ctx.theme.subtle),
    ...(state.planningMode
      ? [span(' · ', ctx.theme.subtle), span('plan mode', chalk.magentaBright)]
      : []),
  ];
  const rightSegments = fileChangeSummarySegments(state, ctx);
  const width = Math.max(1, ctx.width);
  const combinedSegments = [
    ...locationSegments,
    span(' · ', ctx.theme.subtle),
    ...modeLine.segments.slice(1),
  ];
  const combinedWidth =
    segmentsWidth(combinedSegments) +
    segmentsWidth(rightSegments) +
    (rightSegments.length > 0 ? 1 : 0);
  const statusLines =
    combinedWidth <= width
      ? [justifyLine(combinedSegments, rightSegments, width)]
      : [justifyLine(locationSegments, rightSegments, width), modeLine];
  const notice = buildNoticeLine(state, ctx);

  return [...statusLines, ...(notice ? [line(), notice] : [])];
}
