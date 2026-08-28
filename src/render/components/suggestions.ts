import chalk from 'chalk';

import { LEFT_MARGIN } from '../layout';
import { line, span } from '../primitives';
import { repeat, truncateToWidth, widthOf } from '@/text';

import type { Block, RenderContext } from '../types';
import type { ComposerSuggestion } from '@/agent/composer-suggestions';

export function renderSuggestions(
  suggestions: ComposerSuggestion[],
  selectedSuggestion: number,
  ctx: RenderContext,
): Block {
  if (suggestions.length === 0) return [];

  const margin = LEFT_MARGIN.repeat(2);
  const visibleCount = 10;
  const pageStart = Math.floor(selectedSuggestion / visibleCount) * visibleCount;
  const visibleSuggestions = suggestions.slice(pageStart, pageStart + visibleCount);
  const maxCatalogLabelWidth = suggestions.reduce(
    (max, suggestion) =>
      'category' in suggestion ? Math.max(max, widthOf(suggestion.label)) : max,
    0,
  );
  const maxCommandLabelWidth = suggestions.reduce(
    (max, suggestion) =>
      suggestion.kind === 'slash-command' && suggestion.label.startsWith('/')
        ? Math.max(max, widthOf(suggestion.label) + widthOf(suggestion.suffix ?? ''))
        : max,
    0,
  );
  const maxLabelWidth = suggestions.reduce(
    (max, suggestion) =>
      Math.max(
        max,
        widthOf(suggestion.label) +
          widthOf('suffix' in suggestion ? (suggestion.suffix ?? '') : ''),
      ),
    0,
  );

  const lines = visibleSuggestions.map((suggestion, visibleIndex) => {
    const index = pageStart + visibleIndex;
    const selected = index === selectedSuggestion;
    const prefix = selected
      ? [span(margin), span('→', ctx.theme.foreground), span(' ')]
      : [span(`${margin}  `)];
    const prefixWidth = widthOf(`${margin}${selected ? '→ ' : '  '}`);

    if ('category' in suggestion) {
      const availableWidth = Math.max(0, ctx.width - prefixWidth);
      const tag = `[${suggestion.category}]`;
      const responsiveLabelWidth = Math.max(8, Math.floor(availableWidth * 0.36));
      const labelColumnWidth = Math.min(
        maxCatalogLabelWidth,
        30,
        responsiveLabelWidth,
        Math.max(0, availableWidth - widthOf(tag) - 2),
      );
      const visibleLabel = truncateToWidth(suggestion.label, labelColumnWidth);
      const gapWidth = Math.min(
        2,
        Math.max(0, availableWidth - labelColumnWidth - widthOf(tag)),
      );
      const rightWidth = Math.max(0, availableWidth - labelColumnWidth - gapWidth);
      const visibleTag = truncateToWidth(tag, rightWidth);
      const detailWidth = Math.max(
        0,
        rightWidth - widthOf(visibleTag) - (visibleTag && suggestion.detail ? 1 : 0),
      );
      const visibleDetail = truncateToWidth(suggestion.detail, detailWidth);
      const labelStyle = selected ? chalk.cyanBright : ctx.theme.foreground;
      const tagStyle = selected ? chalk.cyanBright : ctx.theme.subtle;
      const detailStyle = selected ? ctx.theme.foreground : ctx.theme.subtle;

      return line(
        ...prefix,
        span(visibleLabel, labelStyle),
        span(repeat(' ', Math.max(0, labelColumnWidth - widthOf(visibleLabel) + gapWidth))),
        ...(visibleTag ? [span(visibleTag, tagStyle)] : []),
        ...(visibleDetail ? [span(' '), span(visibleDetail, detailStyle)] : []),
      );
    }

    if (suggestion.kind === 'slash-command' && suggestion.label.startsWith('/')) {
      const availableWidth = Math.max(0, ctx.width - prefixWidth);
      const responsiveLabelWidth = Math.max(8, Math.floor(availableWidth * 0.36));
      const labelColumnWidth = Math.min(
        maxCommandLabelWidth,
        30,
        responsiveLabelWidth,
        Math.max(0, availableWidth - 2),
      );
      const visibleLabel = truncateToWidth(suggestion.label, labelColumnWidth);
      const suffixWidth = Math.max(0, labelColumnWidth - widthOf(visibleLabel));
      const visibleSuffix =
        visibleLabel === suggestion.label
          ? truncateToWidth(suggestion.suffix ?? '', suffixWidth)
          : '';
      const renderedPrimaryWidth = widthOf(visibleLabel) + widthOf(visibleSuffix);
      const gapWidth = Math.min(3, Math.max(0, availableWidth - labelColumnWidth));
      const detailWidth = Math.max(0, availableWidth - labelColumnWidth - gapWidth);
      const visibleDetail = truncateToWidth(suggestion.detail, detailWidth);
      const labelStyle = suggestion.disabled
        ? chalk.dim
        : selected
          ? chalk.cyanBright
          : ctx.theme.foreground;
      const suffixStyle = suggestion.disabled
        ? chalk.dim
        : selected
          ? chalk.hex('#a5f3fc')
          : ctx.theme.subtle;
      const detailStyle = suggestion.disabled
        ? chalk.dim
        : selected
          ? ctx.theme.foreground
          : ctx.theme.subtle;

      return line(
        ...prefix,
        span(visibleLabel, labelStyle),
        ...(visibleSuffix ? [span(visibleSuffix, suffixStyle)] : []),
        span(
          repeat(
            ' ',
            Math.max(0, labelColumnWidth - renderedPrimaryWidth + gapWidth),
          ),
        ),
        ...(visibleDetail ? [span(visibleDetail, detailStyle)] : []),
      );
    }

    const customLabelStyle = 'labelStyle' in suggestion ? suggestion.labelStyle : undefined;
    const customSuffixStyle = 'suffixStyle' in suggestion ? suggestion.suffixStyle : undefined;
    const customDetailStyle = 'detailStyle' in suggestion ? suggestion.detailStyle : undefined;
    const selectedMentionStyle =
      suggestion.kind === 'mention' ? chalk.magentaBright : undefined;
    const lineStyle =
      selected && selectedMentionStyle
        ? selectedMentionStyle
        : customLabelStyle
          ? selected
            ? customLabelStyle
            : (text: string) => ctx.theme.dimmed(customLabelStyle(text))
          : selected
            ? ctx.theme.foreground
            : ctx.theme.dimmed;
    const suffixStyle = customSuffixStyle || (selected ? ctx.theme.dimmed : ctx.theme.subtle);
    const detailStyle = customDetailStyle || (selected ? ctx.theme.foreground : ctx.theme.subtle);
    const detail = 'detail' in suggestion ? suggestion.detail : '';
    const suffix = 'suffix' in suggestion ? (suggestion.suffix ?? '') : '';
    const renderedWidth = widthOf(suggestion.label) + widthOf(suffix);
    const desiredPaddingWidth = detail ? maxLabelWidth - renderedWidth + 3 : 0;
    const remainingWidth = Math.max(0, ctx.width - prefixWidth - renderedWidth);
    const paddingWidth = detail
      ? remainingWidth >= desiredPaddingWidth + widthOf(detail)
        ? desiredPaddingWidth
        : remainingWidth > 1
          ? 1
          : 0
      : 0;
    const visibleDetail = detail ? truncateToWidth(detail, remainingWidth - paddingWidth) : '';

    return line(
      ...prefix,
      span(suggestion.label, lineStyle),
      ...(suffix ? [span(suffix, suffixStyle)] : []),
      ...(visibleDetail ? [span(repeat(' ', paddingWidth)), span(visibleDetail, detailStyle)] : []),
    );
  });

  lines.push(
    line(
      span(`${margin}  `),
      span(
        `(${Math.min(selectedSuggestion + 1, suggestions.length)}/${suggestions.length})`,
        ctx.theme.dimmed,
      ),
    ),
  );
  return lines;
}
