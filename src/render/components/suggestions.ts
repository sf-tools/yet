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
    const customLabelStyle = 'labelStyle' in suggestion ? suggestion.labelStyle : undefined;
    const customSuffixStyle = 'suffixStyle' in suggestion ? suggestion.suffixStyle : undefined;
    const customDetailStyle = 'detailStyle' in suggestion ? suggestion.detailStyle : undefined;
    const lineStyle = customLabelStyle
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
