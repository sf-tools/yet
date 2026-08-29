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
  prompt?: string;
  resume?: {
    reference?: string;
    last: boolean;
    showAll: boolean;
  };
  model?: string;
  thinkingMode?: ThinkingMode;
  permissionMode?: PermissionMode;
};

type CliResult =
  | StartCliResult
  | { kind: 'agents' }
  | { kind: 'agents-daemon' }
  | { kind: 'exit'; code: number };
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
    `${chalk.bold('Usage:')} ${chalk.white(`${COMMAND_NAME} [options] [prompt]`)}`,
    `       ${chalk.white(`${COMMAND_NAME} resume [session] [options]`)}`,
    '',
    chalk.bold('Commands:'),
    '',
    formatRows([
      ['resume [session]', 'Resume a saved session; opens the inline picker when omitted'],
      ['agents', 'Open the cross-session agent command center'],
    ]),
    '',
    chalk.bold('Options:'),
    '',
    formatRows([
      ['-h, --help', 'Show help'],
      ['-v, --version', 'Show version'],
      ['-m, --model <id>', 'Select one of the supported models below'],
      ['--effort <level>', 'Set reasoning effort: auto, none, low, medium, high, xhigh, max'],
      ['--permissions <mode>', 'Set permissions for this run: ask, auto, full'],
      ['--yolo', 'Run with Full Access; bypass approvals and the workspace sandbox'],
    ]),
    '',
    chalk.bold('Resume options:'),
    '',
    formatRows([
      ['--last', 'Resume the most recently updated session without opening the picker'],
      ['--all', 'Include sessions from every folder'],
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
      ['/fast', 'Toggle priority processing'],
      ['/permissions', 'Change the active permission mode'],
      ['/config', 'Configure Yet settings'],
      ['/plan', 'Toggle read-only planning mode or plan one task'],
      ['/goal', 'Set or view the goal for a long-running task'],
      ['/loop [interval] <prompt>', 'Run a recurring prompt or slash command'],
      ['/compact', 'Compact the current conversation'],
      ['/copy', "Copy the agent's latest response to the clipboard"],
      ['/ps', 'List background terminals'],
      ['/stop', 'Stop all background terminals'],
      ['/subagents', "Switch between this session's subagents"],
      ['/agents', 'Open the cross-session agent command center'],
      ['/resume', 'Resume another saved workspace session'],
      ['/fork [name]', 'Fork the current chat'],
      ['/btw [question]', 'Start an ephemeral side conversation'],
      ['/rename', 'Rename the current session'],
      ['/archive', 'Archive the current session and exit'],
      ['/delete', 'Permanently delete the current session and exit'],
      ['!<command>', 'Run a command through the active permission policy'],
      ['@path/to/file', 'Attach a file to your prompt'],
      ['/exit', 'Quit Yet'],
    ]),
    '',
    chalk.bold('Environment:'),
    '',
    formatRows([
      ['OPENAI_API_KEY', 'Required for model requests'],
      ['SHELL', 'Shell used for command execution (default: /bin/sh)'],
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
  if (argv.length === 1 && argv[0] === 'agents') return { kind: 'agents' };
  if (argv.length === 1 && argv[0] === '__agents-daemon') return { kind: 'agents-daemon' };
  if (argv.length === 1 && ['-h', '--help', 'help'].includes(argv[0])) {
    printHelp();
    return { kind: 'exit', code: 0 };
  }
  if (argv.length === 1 && ['-v', '-V', '--version', 'version'].includes(argv[0])) {
    printVersion();
    return { kind: 'exit', code: 0 };
  }

  const result: StartCliResult = { kind: 'start' };
  const promptParts: string[] = [];
  const resumeCommand = argv[0] === 'resume';
  let resumeReference: string | undefined;
  let resumeLast = false;
  let resumeShowAll = false;

  try {
    for (let index = resumeCommand ? 1 : 0; index < argv.length; index += 1) {
      const arg = argv[index];
      if (arg === '--') {
        promptParts.push(...argv.slice(index + 1));
        break;
      }
      if (arg === '--last') {
        if (!resumeCommand) throw new Error("'--last' can only be used with 'yet resume'.");
        resumeLast = true;
        continue;
      }
      if (arg === '--all') {
        if (!resumeCommand) throw new Error("'--all' can only be used with 'yet resume'.");
        resumeShowAll = true;
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
      if (arg.startsWith('-')) throw new Error(`Invalid argument '${arg}'.`);
      if (resumeCommand && !resumeReference && !resumeLast) resumeReference = arg;
      else promptParts.push(arg);
    }

    if (resumeCommand && resumeLast && resumeReference) {
      if (promptParts.length > 0)
        throw new Error("'yet resume --last' does not accept both a session and a prompt.");
      promptParts.push(resumeReference);
      resumeReference = undefined;
    }

    const prompt = promptParts.join(' ').trim();
    if (prompt) result.prompt = prompt;

    if (result.thinkingMode) {
      const selectedModel = result.model ?? DEFAULT_MODEL;
      const supported = getSupportedThinkingModes(selectedModel);
      if (!supported.includes(result.thinkingMode))
        throw new Error(`${selectedModel} does not support ${result.thinkingMode} effort.`);
    }
    if (resumeCommand) {
      result.resume = {
        ...(resumeReference ? { reference: resumeReference } : {}),
        last: resumeLast,
        showAll: resumeShowAll,
      };
    }
    return result;
  } catch (error) {
    printError(error instanceof Error ? error.message : String(error));
    return { kind: 'exit', code: 1 };
  }
}
