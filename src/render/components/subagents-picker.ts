import chalk from 'chalk';

import type { SubagentsPickerState } from '@/types';
import { truncateToWidth, widthOf } from '@/text';
import { blankLine, line, span } from '../primitives';
import type { Block, RenderContext } from '../types';

const LEFT = '  ';

export function renderSubagentsPicker(state: SubagentsPickerState, ctx: RenderContext): Block {
  const out: Block = [
    line(span(LEFT), span('Subagents', chalk.bold)),
    line(span(LEFT), span('Select an agent to watch. ⌥ + ← previous, ⌥ + → next.', ctx.theme.dimmed)),
    blankLine(),
  ];
  if (state.items.length === 0) {
    out.push(line(span(LEFT), span('No agents available yet.', ctx.theme.dimmed)));
  } else {
    const numberWidth = String(state.items.length).length;
    for (const [index, item] of state.items.entries()) {
      const selected = index === state.selectedIndex;
      const prefix = `${selected ? '›' : ' '} ${String(index + 1).padStart(numberWidth)}. `;
      const dot = item.closed ? '•' : chalk.green('•');
      const current = item.current ? ' (current)' : '';
      const label = `${item.label}${current}`;
      const idWidth = Math.min(36, item.id.length);
      const room = Math.max(1, ctx.width - widthOf(LEFT + prefix) - idWidth - 4);
      const text = truncateToWidth(label, room).padEnd(room);
      const style = selected ? chalk.white : item.closed ? ctx.theme.dimmed : (value: string) => value;
      out.push(line(
        span(LEFT),
        span(prefix, selected ? chalk.white : ctx.theme.dimmed),
        span(`${dot} `),
        span(text, style),
        span(`  ${truncateToWidth(item.id, idWidth)}`, ctx.theme.dimmed),
      ));
    }
  }
  out.push(blankLine());
  out.push(line(span(LEFT), span('Press enter to confirm or esc to go back', ctx.theme.dimmed)));
  return out;
}
