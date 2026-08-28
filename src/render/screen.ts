import { formatWorkspacePath } from '@/text';

import type { RenderContext } from './types';
import type { ThemePalette } from '@/theme';

export function frameWidth(columns = process.stdout.columns || 100) {
  return Math.max(40, columns - 2);
}

export function createRenderContext(
  theme: ThemePalette,
  spinnerFrame: string,
  commandSpinnerFrame: string,
  busySpinnerVerb: string,
  expandPreviews = false,
  columns = process.stdout.columns || 100,
  rows = process.stdout.rows || 30,
): RenderContext {
  const cwd = process.cwd();

  return {
    width: frameWidth(columns),
    height: rows,
    cwd: formatWorkspacePath(cwd),
    spinnerFrame,
    commandSpinnerFrame,
    busySpinnerVerb,
    theme,
    expandPreviews,
  };
}
