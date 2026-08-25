import type { ThemePalette } from '../theme';

export type Style = (text: string) => string;

export type Segment = {
  text: string;
  style?: Style;
};

export type StyledLine = {
  type: 'styled';
  segments: Segment[];
};

export type RawLine = {
  type: 'raw';
  text: string;
};

export type Line = StyledLine | RawLine;
export type Block = Line[];

export type RenderContext = {
  width: number;
  height: number;
  cwd: string;
  gitBranch: string | null;
  spinnerFrame: string;
  commandSpinnerFrame: string;
  busySpinnerVerb: string;
  theme: ThemePalette;
  expandPreviews: boolean;
};

export type ComposerRenderResult = {
  block: Block;
};
