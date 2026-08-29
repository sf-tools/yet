import chalk from 'chalk';

import { resolveInputBinding, splitInputEvents } from '@/agent/keybinds';
import { widthOf } from '@/text';
import {
  getOpenAIAuthSummary,
  loginOpenAIWithApiKey,
  loginOpenAIWithBrowser,
} from './openai';

const BRACKETED_PASTE_START = '\u001b[200~';
const BRACKETED_PASTE_END = '\u001b[201~';
const SCREEN_START = '\u001b[?2026h\u001b[?2004h\u001b[2J\u001b[H\u001b[?25l';
const SCREEN_END = '\u001b[?2026l';

export type OpenAILoginScreenState =
  | { view: 'pick'; selected: 0 | 1; error?: string }
  | { view: 'api-key'; value: string; saving: boolean; error?: string }
  | { view: 'browser'; authorizationUrl: string }
  | { view: 'success'; method: 'oauth' | 'api-key' };

function selectedOption(index: number, selected: boolean, label: string, detail: string) {
  if (selected) {
    return [
      `> ${chalk.cyan.dim(`${index}.`)} ${chalk.cyan(label)}`,
      `     ${chalk.cyan.dim(detail)}`,
    ];
  }
  return [`  ${index}. ${label}`, `     ${chalk.dim(detail)}`];
}

function hyperlink(url: string) {
  const label = chalk.cyan.underline(url);
  return process.stdout.isTTY ? `\u001b]8;;${url}\u001b\\${label}\u001b]8;;\u001b\\` : label;
}

function apiKeyBox(value: string, width: number) {
  const boxWidth = Math.max(24, Math.min(76, width - 4));
  const contentWidth = Math.max(1, boxWidth - 4);
  const placeholder = chalk.dim('Paste or type your API key');
  const masked = value ? '•'.repeat(Math.min(Array.from(value).length, contentWidth)) : placeholder;
  const visibleWidth = widthOf(value ? masked : 'Paste or type your API key');
  const padding = ' '.repeat(Math.max(0, contentWidth - visibleWidth));
  const title = ' API key ';
  return [
    `${chalk.cyan('╭')}${chalk.cyan(title)}${chalk.cyan('─'.repeat(Math.max(0, boxWidth - widthOf(title) - 2)))}${chalk.cyan('╮')}`,
    `${chalk.cyan('│')} ${masked}${padding} ${chalk.cyan('│')}`,
    `${chalk.cyan('╰')}${chalk.cyan('─'.repeat(Math.max(0, boxWidth - 2)))}${chalk.cyan('╯')}`,
  ];
}

export function renderOpenAILoginScreen(
  state: OpenAILoginScreenState,
  width = process.stdout.columns || 80,
) {
  const lines = [
    '',
    `  Welcome to ${chalk.bold('Yet')}, The San Francisco Tooling Company's coding agent`,
    '',
  ];

  if (state.view === 'pick') {
    lines.push(
      '  Sign in with ChatGPT to use Yet as part of your paid plan',
      '  or connect an API key for usage-based billing',
      '',
      ...selectedOption(
        1,
        state.selected === 0,
        'Sign in with ChatGPT',
        'Usage included with Plus, Pro, Business, and Enterprise plans',
      ),
      '',
      ...selectedOption(2, state.selected === 1, 'Provide your own API key', 'Pay for what you use'),
      '',
      `  ${chalk.dim('Press')} ${chalk.bold('Enter')} ${chalk.dim('to continue')}`,
    );
    if (state.error) lines.push('', chalk.red(state.error));
  } else if (state.view === 'api-key') {
    lines.push(
      `> ${chalk.bold('Use your own OpenAI API key for usage-based billing')}`,
      '',
      '  Paste or type your API key below. It will be stored locally in ~/.yet/auth.json.',
      '',
      ...apiKeyBox(state.value, width).map(line => `  ${line}`),
      '',
      `  ${chalk.dim('Press')} ${chalk.bold('Enter')} ${chalk.dim(state.saving ? 'to save · saving…' : 'to save')}`,
      `  ${chalk.dim('Press')} ${chalk.bold('Esc')} ${chalk.dim('to go back')}`,
    );
    if (state.error) lines.push('', chalk.red(state.error));
  } else if (state.view === 'browser') {
    lines.push('  Finish signing in via your browser', '');
    if (state.authorizationUrl) {
      lines.push(
        "  If the link doesn't open automatically, open the following link to authenticate:",
        '',
        `  ${hyperlink(state.authorizationUrl)}`,
        '',
      );
    }
    lines.push(`  ${chalk.dim('Press')} ${chalk.bold('Esc')} ${chalk.dim('to cancel')}`);
  } else if (state.method === 'oauth') {
    lines.push(
      chalk.green('✓ Signed in with your ChatGPT account'),
      '',
      '  Before you start:',
      '',
      '  Decide how much autonomy you want to grant Yet',
      chalk.dim('  Yet can make mistakes. Review the code it writes and commands it runs.'),
      '',
      `  ${chalk.cyan('Press')} ${chalk.bold('Enter')} ${chalk.cyan('to continue')}`,
    );
  } else {
    lines.push(
      chalk.green('✓ API key configured'),
      '',
      '  Yet will use usage-based billing with your API key.',
      '',
      `  ${chalk.cyan('Press')} ${chalk.bold('Enter')} ${chalk.cyan('to continue')}`,
    );
  }

  return lines.join('\n');
}

export async function runOpenAILoginScreen() {
  if (await getOpenAIAuthSummary()) return true;

  const input = process.stdin;
  const output = process.stdout;
  const previousRawMode = input.isRaw;
  let state: OpenAILoginScreenState = { view: 'pick', selected: 0 };
  let inputRemainder = '';
  let bracketedPaste = false;
  let activeLogin: AbortController | null = null;
  let finished = false;

  const render = () => {
    if (finished) return;
    output.write(`${SCREEN_START}${renderOpenAILoginScreen(state)}${SCREEN_END}`);
  };

  const result = new Promise<boolean>(resolve => {
    const cleanup = () => {
      if (finished) return;
      finished = true;
      activeLogin?.abort();
      input.off('data', onData);
      output.off('resize', render);
      if (input.isTTY) input.setRawMode(previousRawMode ?? false);
      input.pause();
      output.write('\u001b[?2026h\u001b[?2004l\u001b[2J\u001b[H\u001b[?25h\u001b[?2026l');
    };

    const finish = (loggedIn: boolean) => {
      cleanup();
      resolve(loggedIn);
    };

    const startBrowserLogin = () => {
      const controller = new AbortController();
      activeLogin = controller;
      state = { view: 'browser', authorizationUrl: '' };
      render();
      void loginOpenAIWithBrowser({
        signal: controller.signal,
        onProgress: progress => {
          if (activeLogin !== controller || controller.signal.aborted) return;
          state = { view: 'browser', authorizationUrl: progress.authorizationUrl };
          render();
        },
      }).then(() => {
        if (activeLogin !== controller || controller.signal.aborted) return;
        activeLogin = null;
        state = { view: 'success', method: 'oauth' };
        render();
      }).catch(error => {
        if (activeLogin !== controller) return;
        activeLogin = null;
        state = {
          view: 'pick',
          selected: 0,
          ...(controller.signal.aborted
            ? {}
            : { error: error instanceof Error ? error.message : String(error) }),
        };
        render();
      });
    };

    const saveApiKey = () => {
      if (state.view !== 'api-key' || state.saving) return;
      const apiKey = state.value.trim();
      if (!apiKey) {
        state = { ...state, error: 'API key cannot be empty' };
        render();
        return;
      }
      state = { ...state, saving: true, error: undefined };
      render();
      void loginOpenAIWithApiKey(apiKey).then(() => {
        state = { view: 'success', method: 'api-key' };
        render();
      }).catch(error => {
        state = {
          view: 'api-key',
          value: apiKey,
          saving: false,
          error: error instanceof Error ? error.message : String(error),
        };
        render();
      });
    };

    const activateSelection = () => {
      if (state.view !== 'pick') return;
      if (state.selected === 0) startBrowserLogin();
      else {
        state = { view: 'api-key', value: '', saving: false };
        render();
      }
    };

    const appendApiKey = (text: string) => {
      if (state.view !== 'api-key' || state.saving) return;
      const next = text.replace(/[\r\n]/g, '');
      if (!next) return;
      state = { ...state, value: `${state.value}${next}`, error: undefined };
      render();
    };

    const handleEvent = (event: string) => {
      if (event === BRACKETED_PASTE_START) {
        bracketedPaste = true;
        return;
      }
      if (event === BRACKETED_PASTE_END) {
        bracketedPaste = false;
        return;
      }
      if (bracketedPaste) {
        appendApiKey(event);
        return;
      }

      const binding = resolveInputBinding(event);
      if (!binding) return;
      if (binding.type === 'interrupt') {
        finish(false);
        return;
      }
      if (binding.type === 'escape') {
        if (state.view === 'browser') {
          const controller = activeLogin;
          activeLogin = null;
          controller?.abort();
          state = { view: 'pick', selected: 0 };
          render();
        } else if (state.view === 'api-key') {
          state = { view: 'pick', selected: 1 };
          render();
        } else if (state.view === 'pick') finish(false);
        return;
      }
      if (state.view === 'success' && binding.type === 'submit') {
        finish(true);
        return;
      }
      if (state.view === 'pick') {
        if (binding.type === 'moveSuggestion') {
          state = { ...state, selected: state.selected === 0 ? 1 : 0, error: undefined };
          render();
        } else if (binding.type === 'submit') activateSelection();
        else if (binding.type === 'insertText' && (binding.text === '1' || binding.text === '2')) {
          state = { view: 'pick', selected: binding.text === '1' ? 0 : 1 };
          activateSelection();
        }
        return;
      }
      if (state.view !== 'api-key' || state.saving) return;
      if (binding.type === 'submit') saveApiKey();
      else if (binding.type === 'backspace') {
        state = { ...state, value: Array.from(state.value).slice(0, -1).join(''), error: undefined };
        render();
      } else if (binding.type === 'insertText') appendApiKey(binding.text);
    };

    function onData(chunk: Buffer | string) {
      const split = splitInputEvents(inputRemainder + chunk.toString('utf8'));
      inputRemainder = split.remainder;
      for (const event of split.events) handleEvent(event);
    }

    if (input.isTTY) input.setRawMode(true);
    input.resume();
    input.on('data', onData);
    output.on('resize', render);
    render();
  });

  return await result;
}
