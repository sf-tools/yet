import type {
  SlashCommand,
  SlashCommandArgumentSuggestion,
  SlashCommandContext,
  SlashCommandInvocation,
  SlashCommandParseResult,
  SlashCommandQuery,
  SlashCommandSuggestion,
  SlashCommandSuggestionContext,
} from './types';

function normalizeInvocation(value: string) {
  return value.trim().replace(/^\//, '').toLowerCase();
}

function splitArgs(argsText: string) {
  const trimmed = argsText.trim();
  return trimmed ? trimmed.split(/\s+/) : [];
}

function compareSuggestions(a: SlashCommandSuggestion, b: SlashCommandSuggestion) {
  return a.label.localeCompare(b.label);
}

function normalizeArgumentSuggestion(suggestion: SlashCommandArgumentSuggestion) {
  return typeof suggestion === 'string' ? { value: suggestion } : suggestion;
}

function getSuggestionContext(context?: SlashCommandSuggestionContext) {
  return context ?? { getSessionId: () => '', getCurrentModel: () => '' };
}

export function currentSlashCommandQuery(
  inputChars: string[],
  cursor: number,
): SlashCommandQuery | null {
  const beforeCursor = inputChars.slice(0, cursor).join('');
  const invocationMatch = beforeCursor.match(/^\/([^\s]*)$/);
  if (invocationMatch) return { type: 'invocation', query: invocationMatch[1] };

  const argumentMatch = beforeCursor.match(/^\/([^\s]+)\s+([^\s]*)$/);
  if (!argumentMatch) return null;

  return {
    type: 'argument',
    invocation: normalizeInvocation(argumentMatch[1]),
    query: argumentMatch[2],
  };
}

export function createSlashCommandRegistry(
  commands: SlashCommand[],
  context?: SlashCommandSuggestionContext,
) {
  const invocations: SlashCommandInvocation[] = [];
  const invocationMap = new Map<string, SlashCommandInvocation>();

  for (const command of commands) {
    const primaryInvocation = normalizeInvocation(command.name);
    const names = [
      { name: command.name, hidden: false, specialHidden: false },
      ...(command.aliases ?? []).map(name => ({ name, hidden: false, specialHidden: false })),
      ...(command.specialHiddenAliases ?? []).map(name => ({
        name,
        hidden: true,
        specialHidden: true,
      })),
    ];

    for (const { name, hidden, specialHidden } of names) {
      const normalized = normalizeInvocation(name);
      if (!normalized) throw new Error('slash commands must have a non-empty name');
      if (invocationMap.has(normalized)) throw new Error(`duplicate slash command: /${normalized}`);

      const invocation: SlashCommandInvocation = {
        command,
        invocation: normalized,
        isAlias: normalized !== primaryInvocation,
        hidden,
        specialHidden,
      };

      invocationMap.set(normalized, invocation);
      invocations.push(invocation);
    }
  }

  const sortedInvocations = invocations
    .slice()
    .sort((a, b) => a.invocation.localeCompare(b.invocation));

  return {
    commands: commands.slice(),

    parse(input: string): SlashCommandParseResult | null {
      const trimmed = input.trim();
      if (!trimmed.startsWith('/')) return null;
      if (trimmed === '/') return { type: 'empty' };

      const match = trimmed.match(/^\/([^\s]+)(?:\s+(.*))?$/);
      if (!match) return { type: 'empty' };

      const invocation = normalizeInvocation(match[1]);
      const resolved = invocationMap.get(invocation);
      if (!resolved) return { type: 'unknown', invocation };

      const argsText = match[2]?.trim() ?? '';

      return {
        type: 'resolved',
        command: resolved.command,
        invocation: resolved.invocation,
        isAlias: resolved.isAlias,
        argsText,
        argv: splitArgs(argsText),
      };
    },

    listSuggestions(query: SlashCommandQuery) {
      const suggestionContext = getSuggestionContext(context);

      const listArgumentSuggestions = (
        invocation: string,
        queryText: string,
        limit = Number.POSITIVE_INFINITY,
      ) => {
        const resolved = invocationMap.get(invocation);
        const rawSuggestions = resolved?.command.argumentSuggestions;
        const values =
          typeof rawSuggestions === 'function'
            ? rawSuggestions(suggestionContext)
            : (rawSuggestions ?? []);
        const normalizedQuery = normalizeInvocation(queryText);

        return values
          .map(normalizeArgumentSuggestion)
          .filter(suggestion => {
            if (!normalizedQuery) return true;
            const normalizedValue = normalizeInvocation(suggestion.value);
            const normalizedLabel = normalizeInvocation(suggestion.label ?? suggestion.value);
            return (
              normalizedValue.startsWith(normalizedQuery) ||
              normalizedValue.includes(normalizedQuery) ||
              normalizedLabel.startsWith(normalizedQuery) ||
              normalizedLabel.includes(normalizedQuery)
            );
          })
          .slice(0, limit)
          .map<SlashCommandSuggestion>(suggestion => {
            const canonicalInvocation = normalizeInvocation(resolved?.command.name ?? invocation);
            const disabled = resolved?.command.isAvailable
              ? !resolved.command.isAvailable(suggestionContext)
              : undefined;
            const detail =
              disabled && resolved?.command.unavailableDetail
                ? resolved.command.unavailableDetail(suggestionContext)
                : (suggestion.detail ?? resolved?.command.description ?? '');

            return {
              kind: 'slash-command',
              label: suggestion.label ?? suggestion.value,
              suffix: suggestion.suffix,
              detail,
              invocation: canonicalInvocation,
              replacement: `/${canonicalInvocation} ${suggestion.value}`,
              commandName: resolved?.command.name ?? invocation,
              isAlias: Boolean(resolved?.isAlias),
              disabled,
              labelStyle: suggestion.labelStyle,
              suffixStyle: suggestion.suffixStyle,
              detailStyle: suggestion.detailStyle,
            };
          });
      };

      if (query.type === 'argument') return listArgumentSuggestions(query.invocation, query.query);

      const normalizedQuery = normalizeInvocation(query.query);
      const exactInvocation = invocationMap.get(normalizedQuery);
      if (exactInvocation?.command.showArgumentSuggestionsOnExactInvocation) {
        return listArgumentSuggestions(exactInvocation.invocation, '', Number.POSITIVE_INFINITY);
      }

      const suggestions = sortedInvocations
        .filter(({ command, invocation, hidden, specialHidden }) => {
          if (command.isAvailable && !command.isAvailable(suggestionContext)) return false;
          if (!normalizedQuery) return !hidden;
          if (specialHidden) return invocation.startsWith(normalizedQuery);
          if (hidden) return false;
          return invocation.startsWith(normalizedQuery) || invocation.includes(normalizedQuery);
        })
        .map<SlashCommandSuggestion>(({ command, invocation, isAlias, specialHidden }) => {
          const canonicalInvocation = normalizeInvocation(command.name);
          const replacementInvocation = specialHidden ? canonicalInvocation : invocation;

          return {
            kind: 'slash-command',
            label: `/${replacementInvocation}`,
            suffix: command.suggestedInput ? ` ${command.suggestedInput}` : undefined,
            detail: isAlias
              ? `Alias for /${command.name} · ${command.description}`
              : command.description,
            invocation: replacementInvocation,
            replacement: `/${replacementInvocation}`,
            commandName: command.name,
            isAlias,
          };
        });

      return suggestions.sort(compareSuggestions);
    },
  };
}
