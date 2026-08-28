import { stderr, stdout } from 'node:process';
import chalk from 'chalk';

import {
  APP_RELEASE_DATE_ISO,
  APP_RELEASE_UNIX_TIME,
  APP_VERSION,
  DEFAULT_MODEL,
  OPENAI_MODEL_OPTIONS,
  getSupportedThinkingModes,
  isSupportedOpenAIModel,
  isThinkingMode,
  normalizeOpenAIModelId,
  type ThinkingMode,
} from '@/config';
import { isPermissionMode, type PermissionMode } from '@/permissions';

export type StartCliResult = {
  kind: 'start';
  resumeId?: string;
  resumePicker?: boolean;
  model?: string;
  thinkingMode?: ThinkingMode;
  permissionMode?: PermissionMode;
};

type CliResult = StartCliResult | { kind: 'exit'; code: number };
const COMMAND_NAME = 'yet';

function formatRows(rows: Array<[string, string]>, indent = '  ') {
  const width = rows.reduce((max, [left]) => Math.max(max, left.length), 0);
  return rows
    .map(([left, right]) => `${indent}${chalk.white(left.padEnd(width))}  ${right}`)
    .join('\n');
}

function formatRelativeAge(unixTime: number) {
  const ageSeconds = Math.max(0, Math.floor(Date.now() / 1000) - unixTime);
  if (ageSeconds < 60) return `${ageSeconds}s ago`;
  if (ageSeconds < 3600) return `${Math.floor(ageSeconds / 60)}m ago`;
  if (ageSeconds < 86_400) return `${Math.floor(ageSeconds / 3600)}h ago`;
  if (ageSeconds < 2_592_000) return `${Math.floor(ageSeconds / 86_400)}d ago`;
  if (ageSeconds < 31_536_000) return `${Math.floor(ageSeconds / 2_592_000)}mo ago`;
  return `${Math.floor(ageSeconds / 31_536_000)}y ago`;
}

function printVersion() {
  stdout.write(
    `${APP_VERSION} (released ${APP_RELEASE_DATE_ISO}, ${formatRelativeAge(APP_RELEASE_UNIX_TIME)})\n`,
  );
}

function printHelp() {
  const models = OPENAI_MODEL_OPTIONS.map((model, index) => [
    `${index + 1}. ${model.id}${model.id === DEFAULT_MODEL ? ' (default)' : ''}`,
    model.description,
  ] as [string, string]);
  const sections = [
    `${chalk.bold('Yet')} ${chalk.dim(APP_VERSION)}`,
    '',
    'Your best work is yet to come.',
    '',
    `${chalk.bold('Usage:')} ${chalk.white(`${COMMAND_NAME} [options]`)}`,
    '',
    chalk.bold('Options:'),
    '',
    formatRows([
      ['-h, --help', 'Show help'],
      ['-v, --version', 'Show version'],
      ['--resume [id]', 'Resume a saved session, or pick one from this workspace'],
      ['-m, --model <id>', 'Select one of the supported models below'],
      ['--effort <level>', 'Set reasoning effort: auto, none, low, medium, high, xhigh, max'],
      ['--permissions <mode>', 'Set permissions for this run: ask, auto, full'],
      ['--yolo', 'Run with Full Access; bypass approvals and the workspace sandbox'],
    ]),
    '',
    chalk.bold('Models:'),
    '',
    formatRows(models),
    '',
    chalk.bold('In-session:'),
    '',
    formatRows([
      ['/status', 'Show runtime, session, model, permission, and tool status'],
      ['/model', 'Switch among the supported models'],
      ['/effort', 'Change reasoning effort'],
      ['/permissions', 'Change the active permission mode'],
      ['/config', 'Configure Yet settings'],
      ['/plan', 'Toggle read-only planning mode or plan one task'],
      ['/compact', 'Compact the current conversation'],
      ['/copy', "Copy the agent's latest response to the clipboard"],
      ['/resume', 'Resume another saved workspace session'],
      ['/fork [name]', 'Fork the current chat'],
      ['/btw [question]', 'Start an ephemeral side conversation'],
      ['/rename', 'Rename the current session'],
      ['!<command>', 'Run a command through the active permission policy'],
      ['@path/to/file', 'Attach a file to your prompt'],
      ['/exit', 'Quit Yet'],
    ]),
    '',
    chalk.bold('Environment:'),
    '',
    formatRows([
      ['OPENAI_API_KEY', 'Required for model requests'],
      ['SHELL', 'Shell used by the shell tool (default: /bin/sh)'],
    ]),
    '',
  ];
  stdout.write(`${sections.join('\n')}\n`);
}

function printError(message: string) {
  stderr.write(`${chalk.bold('Error:')} ${message}\n`);
  stderr.write(`${chalk.dim(`Run '${COMMAND_NAME} --help' for usage.`)}\n`);
}

function takeValue(argv: string[], index: number, flag: string) {
  const value = argv[index + 1];
  if (!value || value.startsWith('-')) throw new Error(`Missing value for '${flag}'.`);
  return value;
}

export function handleCliArgs(argv = process.argv.slice(2)): CliResult {
  if (argv.length === 1 && ['-h', '--help', 'help'].includes(argv[0])) {
    printHelp();
    return { kind: 'exit', code: 0 };
  }
  if (argv.length === 1 && ['-v', '-V', '--version', 'version'].includes(argv[0])) {
    printVersion();
    return { kind: 'exit', code: 0 };
  }

  const result: StartCliResult = { kind: 'start' };

  try {
    for (let index = 0; index < argv.length; index += 1) {
      const arg = argv[index];
      if (arg === '--resume') {
        const next = argv[index + 1];
        if (!next || next.startsWith('-')) result.resumePicker = true;
        else {
          result.resumeId = next;
          index += 1;
        }
        continue;
      }
      if (arg.startsWith('--resume=')) {
        const value = arg.slice('--resume='.length);
        if (value) result.resumeId = value;
        else result.resumePicker = true;
        continue;
      }
      if (arg === '-m' || arg === '--model') {
        const model = normalizeOpenAIModelId(takeValue(argv, index, arg));
        if (!isSupportedOpenAIModel(model)) throw new Error(`Unsupported model '${model}'.`);
        result.model = model;
        index += 1;
        continue;
      }
      if (arg === '--effort' || arg === '--reasoning') {
        const effort = takeValue(argv, index, arg).toLowerCase();
        if (!isThinkingMode(effort)) throw new Error(`Unsupported reasoning effort '${effort}'.`);
        result.thinkingMode = effort;
        index += 1;
        continue;
      }
      if (arg === '--permissions') {
        const mode = takeValue(argv, index, arg).toLowerCase();
        if (!isPermissionMode(mode)) throw new Error(`Invalid permission mode '${mode}'.`);
        result.permissionMode = mode;
        index += 1;
        continue;
      }
      if (arg === '--yolo' || arg === '--dangerously-bypass-approvals-and-sandbox') {
        result.permissionMode = 'full';
        continue;
      }
      throw new Error(`Invalid argument '${arg}'.`);
    }

    if (result.thinkingMode) {
      const selectedModel = result.model ?? DEFAULT_MODEL;
      const supported = getSupportedThinkingModes(selectedModel);
      if (!supported.includes(result.thinkingMode))
        throw new Error(`${selectedModel} does not support ${result.thinkingMode} effort.`);
    }
    if (result.resumeId && result.resumePicker)
      throw new Error('Choose either a resume id or the resume picker, not both.');
    return result;
  } catch (error) {
    printError(error instanceof Error ? error.message : String(error));
    return { kind: 'exit', code: 1 };
  }
}
