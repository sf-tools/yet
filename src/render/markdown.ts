import chalk from 'chalk';
import MarkdownIt from 'markdown-it';
import Prism from 'prismjs';

import 'prismjs/components/prism-markup.js';
import 'prismjs/components/prism-clike.js';
import 'prismjs/components/prism-javascript.js';
import 'prismjs/components/prism-jsx.js';
import 'prismjs/components/prism-typescript.js';
import 'prismjs/components/prism-tsx.js';
import 'prismjs/components/prism-json.js';
import 'prismjs/components/prism-bash.js';
import 'prismjs/components/prism-diff.js';
import 'prismjs/components/prism-python.js';
import 'prismjs/components/prism-go.js';
import 'prismjs/components/prism-rust.js';
import 'prismjs/components/prism-yaml.js';
import 'prismjs/components/prism-toml.js';
import 'prismjs/components/prism-sql.js';
import 'prismjs/components/prism-markdown.js';

import { repeat, truncateToWidth, widthOf } from '@/text';
import { indent, prefixWidth } from './layout';
import { blankLine, line, span } from './primitives';
import {
  hideWebLinkDestination,
  osc8Hyperlink,
  webDestination,
} from './terminal-hyperlinks';
import type { Block, RenderContext, Segment, Style, StyledLine } from './types';

const md = new MarkdownIt({
  linkify: true,
});

const CODE_LANGUAGE_ALIASES: Record<string, string> = {
  cjs: 'javascript',
  console: 'bash',
  html: 'markup',
  htm: 'markup',
  js: 'javascript',
  mjs: 'javascript',
  rs: 'rust',
  py: 'python',
  shell: 'bash',
  sh: 'bash',
  text: 'plain',
  plaintext: 'plain',
  ts: 'typescript',
  yml: 'yaml',
  zsh: 'bash',
};

type MarkdownToken = ReturnType<typeof md.parse>[number];
type PrismTokenStream = string | Prism.Token | PrismTokenStream[];
type InlinePiece = { type: 'segment'; segment: Segment } | { type: 'break' };

type RenderEnv = {
  ctx: RenderContext;
  width: number;
};

function composeStyles(...styles: Array<Style | undefined>): Style | undefined {
  const active = styles.filter(Boolean) as Style[];
  if (active.length === 0) return undefined;
  return value => active.reduce((out, style) => style(out), value);
}

function appendSegment(pieces: InlinePiece[], text: string, style?: Style) {
  if (!text) return;

  const last = pieces[pieces.length - 1];
  if (last?.type === 'segment' && last.segment.style === style) {
    last.segment.text += text;
    return;
  }

  pieces.push({ type: 'segment', segment: span(text, style) });
}

function appendBreak(pieces: InlinePiece[]) {
  const last = pieces[pieces.length - 1];
  if (last?.type === 'break') return;
  pieces.push({ type: 'break' });
}

function appendText(pieces: InlinePiece[], text: string, style?: Style) {
  const parts = text.split('\n');

  parts.forEach((part, index) => {
    appendSegment(pieces, part, style);
    if (index < parts.length - 1) appendBreak(pieces);
  });
}

function textToBlock(text: string, width: number, style?: Style) {
  const pieces: InlinePiece[] = [];
  appendText(pieces, text, style);
  return wrapInlinePieces(pieces, width);
}

function getAttr(token: MarkdownToken, name: string) {
  return typeof token.attrGet === 'function' ? token.attrGet(name) : null;
}

function plainText(pieces: InlinePiece[]) {
  return pieces.map(piece => (piece.type === 'break' ? '\n' : piece.segment.text)).join('');
}

function wrapInlinePieces(pieces: InlinePiece[], width: number): StyledLine[] {
  const safeWidth = Math.max(1, width);
  const lines: StyledLine[] = [];
  let segments: Segment[] = [];
  let currentWidth = 0;

  const pushText = (text: string, style?: Style) => {
    if (!text) return;
    const last = segments[segments.length - 1];
    if (last && last.style === style) {
      last.text += text;
      return;
    }
    segments.push(span(text, style));
  };

  const flushLine = (allowEmpty = false) => {
    if (segments.length === 0 && !allowEmpty) return;
    lines.push(line(...segments));
    segments = [];
    currentWidth = 0;
  };

  const pushAtom = (text: string, style?: Style) => {
    if (!text) return;
    const atomWidth = widthOf(text);
    if (!/^\s+$/.test(text) && segments.length > 0 && currentWidth + atomWidth > safeWidth) {
      flushLine();
    }

    for (const ch of Array.from(text)) {
      const chWidth = Math.max(1, widthOf(ch));
      if (segments.length > 0 && currentWidth + chWidth > safeWidth) flushLine();
      pushText(ch, style);
      currentWidth += chWidth;
    }
  };

  for (const piece of pieces) {
    if (piece.type === 'break') {
      flushLine(true);
      continue;
    }
    for (const atom of piece.segment.text.match(/\s+|\S+/gu) ?? []) {
      pushAtom(atom, piece.segment.style);
    }
  }

  flushLine(true);
  return lines;
}

export function normalizeCodeLanguage(language: string | null) {
  if (!language) return null;

  const normalized = language.trim().toLowerCase();
  if (!normalized) return null;

  const resolved = CODE_LANGUAGE_ALIASES[normalized] ?? normalized;
  if (resolved === 'plain') return null;

  return (Prism.languages as Record<string, unknown>)[resolved] ? resolved : null;
}

function hasCodeType(types: string[], ...candidates: string[]) {
  return candidates.some(candidate => types.includes(candidate));
}

function codeTokenStyle(types: string[], ctx: RenderContext): Style | undefined {
  const styles: Style[] = [];

  if (hasCodeType(types, 'comment', 'prolog', 'doctype', 'cdata')) styles.push(ctx.theme.dimmed);
  if (hasCodeType(types, 'keyword', 'atrule', 'important'))
    styles.push(value => chalk.cyanBright(value));
  if (hasCodeType(types, 'boolean', 'number', 'constant', 'symbol'))
    styles.push(value => chalk.magentaBright(value));
  if (hasCodeType(types, 'string', 'char', 'attr-value', 'template-string'))
    styles.push(value => chalk.greenBright(value));
  if (hasCodeType(types, 'regex')) styles.push(value => chalk.redBright(value));
  if (hasCodeType(types, 'function', 'function-variable'))
    styles.push(value => chalk.blueBright(value));
  if (hasCodeType(types, 'class-name', 'builtin')) styles.push(value => chalk.white(value));
  if (hasCodeType(types, 'property', 'tag', 'selector', 'namespace', 'attr-name'))
    styles.push(value => chalk.cyan(value));
  if (hasCodeType(types, 'operator', 'entity', 'url'))
    styles.push(value => chalk.cyanBright(value));
  if (hasCodeType(types, 'punctuation')) styles.push(ctx.theme.subtle);
  if (hasCodeType(types, 'deleted')) styles.push(value => chalk.red(value));
  if (hasCodeType(types, 'inserted')) styles.push(value => chalk.green(value));
  if (hasCodeType(types, 'italic')) styles.push(value => chalk.italic(value));
  if (hasCodeType(types, 'bold')) styles.push(value => chalk.bold(value));

  return composeStyles(...styles);
}

function appendPrismToken(
  pieces: InlinePiece[],
  token: PrismTokenStream,
  ctx: RenderContext,
  inheritedTypes: string[] = [],
) {
  if (typeof token === 'string') {
    appendText(pieces, token, codeTokenStyle(inheritedTypes, ctx));
    return;
  }

  if (Array.isArray(token)) {
    token.forEach(part => appendPrismToken(pieces, part, ctx, inheritedTypes));
    return;
  }

  const aliases = token.alias ? (Array.isArray(token.alias) ? token.alias : [token.alias]) : [];
  const types = [...inheritedTypes, token.type, ...aliases];
  appendPrismToken(pieces, token.content as PrismTokenStream, ctx, types);
}

export function highlightedCodeBlock(code: string, language: string | null, ctx: RenderContext) {
  if (!language) return textToBlock(code, Number.POSITIVE_INFINITY);

  const grammar = (Prism.languages as Record<string, Prism.Grammar | undefined>)[language];
  if (!grammar) return textToBlock(code, Number.POSITIVE_INFINITY);

  const pieces: InlinePiece[] = [];
  appendPrismToken(pieces, Prism.tokenize(code, grammar), ctx);
  return wrapInlinePieces(pieces, Number.POSITIVE_INFINITY);
}

function collectInlineRange(
  tokens: MarkdownToken[],
  env: RenderEnv,
  start = 0,
  endType?: string,
  inheritedStyle?: Style,
): { pieces: InlinePiece[]; next: number } {
  const pieces: InlinePiece[] = [];
  let index = start;

  while (index < tokens.length) {
    const token = tokens[index];
    if (endType && token.type === endType) return { pieces, next: index + 1 };

    switch (token.type) {
      case 'text':
        appendText(pieces, token.content, inheritedStyle);
        index += 1;
        break;

      case 'code_inline':
        appendText(
          pieces,
          token.content,
          composeStyles(inheritedStyle, chalk.cyan),
        );
        index += 1;
        break;

      case 'softbreak':
      case 'hardbreak':
        appendBreak(pieces);
        index += 1;
        break;

      case 'strong_open': {
        const inner = collectInlineRange(
          tokens,
          env,
          index + 1,
          'strong_close',
          composeStyles(inheritedStyle, value => chalk.bold(value)),
        );
        pieces.push(...inner.pieces);
        index = inner.next;
        break;
      }

      case 'em_open': {
        const inner = collectInlineRange(
          tokens,
          env,
          index + 1,
          'em_close',
          composeStyles(inheritedStyle, value => chalk.italic(value)),
        );
        pieces.push(...inner.pieces);
        index = inner.next;
        break;
      }

      case 's_open': {
        const inner = collectInlineRange(
          tokens,
          env,
          index + 1,
          's_close',
          composeStyles(inheritedStyle, value => chalk.strikethrough(value)),
        );
        pieces.push(...inner.pieces);
        index = inner.next;
        break;
      }

      case 'link_open': {
        const href = getAttr(token, 'href');
        const normalizedHref = href == null ? undefined : String(href).trim();
        const safeWebDestination = normalizedHref
          ? webDestination(normalizedHref)
          : null;
        const linkStyle = composeStyles(
          inheritedStyle,
          value => chalk.cyanBright.underline(value),
          safeWebDestination
            ? value => osc8Hyperlink(safeWebDestination, value)
            : undefined,
        );
        const inner = collectInlineRange(
          tokens,
          env,
          index + 1,
          'link_close',
          linkStyle,
        );
        pieces.push(...inner.pieces);

        if (normalizedHref && !hideWebLinkDestination(normalizedHref)) {
          appendSegment(pieces, ' (', inheritedStyle);
          appendSegment(
            pieces,
            normalizedHref,
            composeStyles(inheritedStyle, chalk.cyan.underline),
          );
          appendSegment(pieces, ')', inheritedStyle);
        }

        index = inner.next;
        break;
      }

      case 'image': {
        const alt = String(token.content || getAttr(token, 'alt') || 'image');
        appendText(pieces, alt, inheritedStyle);
        index += 1;
        break;
      }

      case 'html_inline':
        appendText(pieces, token.content, composeStyles(inheritedStyle, env.ctx.theme.dimmed));
        index += 1;
        break;

      default:
        appendText(pieces, token.content, inheritedStyle);
        index += 1;
        break;
    }
  }

  return { pieces, next: index };
}

function renderInline(
  children: MarkdownToken[] | null | undefined,
  env: RenderEnv,
  baseStyle?: Style,
) {
  return wrapInlinePieces(
    collectInlineRange(children ?? [], env, 0, undefined, baseStyle).pieces,
    env.width,
  );
}

function renderParagraph(children: MarkdownToken[] | null | undefined, env: RenderEnv): Block {
  return renderInline(children, env);
}

function renderHeading(
  token: MarkdownToken,
  children: MarkdownToken[] | null | undefined,
  env: RenderEnv,
): Block {
  const level = Number.parseInt(token.tag.slice(1), 10) || 1;
  const prefix = `${'#'.repeat(Math.max(1, Math.min(level, 6)))} `;
  const headingStyle: Style = value => {
    if (level === 1) return chalk.bold.underline(value);
    if (level === 2) return chalk.bold(value);
    if (level === 3) return chalk.bold.italic(value);
    return chalk.italic(value);
  };

  const lines = renderInline(children, env, headingStyle);
  if (lines.length === 0) return [line(span(prefix, env.ctx.theme.subtle))];

  const [first, ...rest] = lines;
  return [line(span(prefix, env.ctx.theme.subtle), ...first.segments), ...rest];
}

function renderCodeBlock(token: MarkdownToken, env: RenderEnv): Block {
  const rawLanguage = token.info.trim().split(/\s+/)[0] || null;
  const language = normalizeCodeLanguage(rawLanguage);
  const content = token.content.replace(/\n$/, '');
  return highlightedCodeBlock(content, language, env.ctx);
}

function appendBlock(out: Block, block: Block, withSpacing = true) {
  if (block.length === 0) return;
  if (withSpacing && out.length > 0) out.push(blankLine());
  out.push(...block);
}

function renderTable(
  tokens: MarkdownToken[],
  env: RenderEnv,
  start: number,
): { block: Block; next: number } {
  const rows: string[][] = [];
  const alignments: Array<'left' | 'center' | 'right'> = [];
  let row: string[] | null = null;
  let index = start + 1;

  while (index < tokens.length) {
    const token = tokens[index];
    if (token.type === 'table_close') break;
    if (token.type === 'tr_open') row = [];
    if (token.type === 'tr_close' && row) {
      rows.push(row);
      row = null;
    }
    if ((token.type === 'th_open' || token.type === 'td_open') && row) {
      const inline = tokens[index + 1];
      const text = inline?.type === 'inline'
        ? plainText(collectInlineRange(inline.children ?? [], env).pieces).replace(/\s+/g, ' ').trim()
        : '';
      row.push(text);
      if (rows.length === 0) {
        const style = String(getAttr(token, 'style') ?? '');
        alignments.push(
          style.includes('center') ? 'center' : style.includes('right') ? 'right' : 'left',
        );
      }
    }
    index += 1;
  }

  if (rows.length === 0) return { block: [], next: index + 1 };
  const columnCount = Math.max(...rows.map(current => current.length));
  const widths = Array.from({ length: columnCount }, (_, column) =>
    Math.max(3, ...rows.map(current => widthOf(current[column] ?? ''))),
  );
  const gapWidth = Math.max(0, columnCount - 1) * 2;
  const paddingWidth = columnCount * 2;
  while (widths.reduce((sum, value) => sum + value, 0) + gapWidth + paddingWidth > env.width) {
    const widest = widths.reduce((best, value, column) =>
      value > widths[best] ? column : best, 0);
    if (widths[widest] <= 3) break;
    widths[widest] -= 1;
  }

  const tableWidth = widths.reduce((sum, value) => sum + value, 0) + gapWidth + paddingWidth;
  if (tableWidth > env.width && rows.length > 1) {
    const header = rows[0] ?? [];
    const recordWidth = Math.max(1, env.width - 2);
    const block: Block = [];
    rows.slice(1).forEach((current, rowIndex) => {
      if (rowIndex > 0) block.push(line(span(repeat('─', env.width), env.ctx.theme.subtle)));
      header.forEach((label, column) => {
        block.push(line(span(' '), span(label, chalk.bold)));
        block.push(...indent(textToBlock(current[column] ?? '', recordWidth), '  '));
      });
    });
    return { block, next: index + 1 };
  }

  const pad = (value: string, column: number) => {
    const visible = truncateToWidth(value, widths[column]);
    const remaining = Math.max(0, widths[column] - widthOf(visible));
    const alignment = alignments[column] ?? 'left';
    const left = alignment === 'right' ? remaining : alignment === 'center' ? Math.floor(remaining / 2) : 0;
    const right = remaining - left;
    return `${' '.repeat(left)}${visible}${' '.repeat(right)}`;
  };
  const block: Block = [];
  rows.forEach((current, rowIndex) => {
    if (rowIndex > 1) {
      block.push(
        line(
          span(' '),
          ...widths.flatMap((value, column) => [
            ...(column > 0 ? [span('  ')] : []),
            span(repeat('─', value + 2), env.ctx.theme.subtle),
          ]),
        ),
      );
    }
    block.push(
      line(
        span(' '),
        ...current.flatMap((value, column) => [
          ...(column > 0 ? [span('  ')] : []),
          span(` ${pad(value, column)} `, rowIndex === 0 ? chalk.bold : undefined),
        ]),
      ),
    );
    if (rowIndex === 0) {
      block.push(
        line(
          span(' '),
          ...widths.flatMap((value, column) => [
            ...(column > 0 ? [span('  ')] : []),
            span(repeat('━', value + 2), chalk.cyan),
          ]),
        ),
      );
    }
  });
  return { block, next: index + 1 };
}

function renderRange(
  tokens: MarkdownToken[],
  env: RenderEnv,
  start = 0,
  endType?: string,
): { block: Block; next: number } {
  const out: Block = [];
  let index = start;

  while (index < tokens.length) {
    const token = tokens[index];
    if (endType && token.type === endType) return { block: out, next: index + 1 };

    switch (token.type) {
      case 'paragraph_open':
        appendBlock(out, renderParagraph(tokens[index + 1]?.children, env));
        index += 3;
        break;

      case 'heading_open':
        appendBlock(out, renderHeading(token, tokens[index + 1]?.children, env));
        index += 3;
        break;

      case 'bullet_list_open': {
        const rendered = renderList(tokens, env, index, false);
        appendBlock(out, rendered.block);
        index = rendered.next;
        break;
      }

      case 'ordered_list_open': {
        const rendered = renderList(tokens, env, index, true);
        appendBlock(out, rendered.block);
        index = rendered.next;
        break;
      }

      case 'table_open': {
        const rendered = renderTable(tokens, env, index);
        appendBlock(out, rendered.block);
        index = rendered.next;
        break;
      }

      case 'blockquote_open': {
        const inner = renderRange(
          tokens,
          { ...env, width: Math.max(1, env.width - 2) },
          index + 1,
          'blockquote_close',
        );
        appendBlock(
          out,
          indent(inner.block, [span('> ', chalk.green)], [span('> ', chalk.green)]).map(entry => {
            if (entry.type === 'raw') return entry;
            return line(
              ...entry.segments.map(segment =>
                span(segment.text, composeStyles(segment.style, chalk.green)),
              ),
            );
          }),
        );
        index = inner.next;
        break;
      }

      case 'fence':
      case 'code_block':
        appendBlock(out, renderCodeBlock(token, env));
        index += 1;
        break;

      case 'hr':
        appendBlock(out, [line(span('———'))]);
        index += 1;
        break;

      case 'inline':
        appendBlock(out, renderInline(token.children, env));
        index += 1;
        break;

      case 'html_block':
        appendBlock(out, textToBlock(token.content.trimEnd(), env.width, env.ctx.theme.dimmed));
        index += 1;
        break;

      default:
        index += 1;
        break;
    }
  }

  return { block: out, next: index };
}

function renderList(
  tokens: MarkdownToken[],
  env: RenderEnv,
  start: number,
  ordered: boolean,
): { block: Block; next: number } {
  const listToken = tokens[start];
  const closeType = ordered ? 'ordered_list_close' : 'bullet_list_close';
  const out: Block = [];
  let index = start + 1;
  let order = Number.parseInt(String(getAttr(listToken, 'start') ?? '1'), 10);
  let separateNextItem = false;

  while (index < tokens.length) {
    const token = tokens[index];
    if (token.type === closeType) return { block: out, next: index + 1 };
    if (token.type !== 'list_item_open') {
      index += 1;
      continue;
    }

    const bullet = ordered ? `${order}. ` : '- ';
    const continuation = repeat(' ', prefixWidth(bullet));
    const innerEnv = { ...env, width: Math.max(1, env.width - prefixWidth(bullet)) };
    const item = renderRange(tokens, innerEnv, index + 1, 'list_item_close');

    if (separateNextItem && out.length > 0) out.push(blankLine());
    out.push(
      ...indent(
        item.block,
        [span(bullet, ordered ? chalk.hex('#8ab4fa') : undefined)],
        [span(continuation)],
      ),
    );
    separateNextItem = item.block.length > 1;

    index = item.next;
    order += 1;
  }

  return { block: out, next: index };
}

export function renderMarkdown(
  text: string,
  ctx: RenderContext,
  width = Math.max(1, ctx.width - 2),
): Block {
  const tokens = md.parse(text, {});
  return renderRange(tokens, { ctx, width }).block;
}
