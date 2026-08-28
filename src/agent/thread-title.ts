import { generateOpenAIText } from '@/providers/openai';

export const THREAD_TITLE_MAX_CHARS = 36;
export const THREAD_TITLE_PROMPT_MAX_BYTES = 960;
export const THREAD_TITLE_MODEL = 'gpt-5.6-luna';

export function createProvisionalThreadTitle(userMessage: string) {
  return Array.from(userMessage.trim().replace(/\s+/g, ' '))
    .slice(0, THREAD_TITLE_MAX_CHARS)
    .join('');
}

function titleInstructions() {
  return [
    `Generate a concise, single-line task title of at most ${THREAD_TITLE_MAX_CHARS} characters and under five words where possible.`,
    'Start with an imperative verb.',
    'Capitalize only the first word unless the user language, proper nouns, acronyms, or code terms require otherwise.',
    'Preserve ticket references exactly.',
    'Write in the user language.',
    'Do not use quotes, markdown, or trailing punctuation.',
    'Do not answer the request.',
  ].join(' ');
}

export function createThreadTitlePrompt(userMessage: string) {
  const prefix = `${titleInstructions()}\n\nUser prompt:\n`;
  const remainingBytes = Math.max(0, THREAD_TITLE_PROMPT_MAX_BYTES - Buffer.byteLength(prefix));
  let prompt = '';
  let bytes = 0;
  for (const character of userMessage.trim()) {
    const characterBytes = Buffer.byteLength(character);
    if (bytes + characterBytes > remainingBytes) break;
    prompt += character;
    bytes += characterBytes;
  }
  return `${prefix}${prompt}`;
}

export function parseGeneratedThreadTitle(response: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(response) as unknown;
  } catch {
    return null;
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    Object.keys(parsed).some(key => key !== 'title') ||
    typeof (parsed as { title?: unknown }).title !== 'string'
  ) {
    return null;
  }

  const normalized = (parsed as { title: string }).title
    .trim()
    .replace(/^['"`“”‘’]+|['"`“”‘’]+$/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[.!?]+$/, '')
    .trim();
  if (!normalized) return null;
  return Array.from(normalized).slice(0, THREAD_TITLE_MAX_CHARS).join('');
}

export async function requestGeneratedThreadTitle(userMessage: string, signal?: AbortSignal) {
  const { text } = await generateOpenAIText({
    model: THREAD_TITLE_MODEL,
    thinkingMode: 'low',
    messages: [{ role: 'user', content: createThreadTitlePrompt(userMessage) }],
    signal,
    store: false,
    text: {
      format: {
        type: 'json_schema',
        name: 'thread_title',
        strict: true,
        schema: {
          type: 'object',
          properties: {
            title: { type: 'string', minLength: 1, maxLength: THREAD_TITLE_MAX_CHARS },
          },
          required: ['title'],
          additionalProperties: false,
        },
      },
      verbosity: 'low',
    },
  });
  return parseGeneratedThreadTitle(text);
}

export type BackgroundThreadTitleRequest = { cancel(): void };

export function startBackgroundThreadTitle(options: {
  userMessage: string;
  expectedTitle: string;
  getCurrentTitle(): string | null;
  applyTitle(title: string): void;
  onSettled?(): void;
  generate?: (userMessage: string, signal: AbortSignal) => Promise<string | null>;
}): BackgroundThreadTitleRequest {
  const controller = new AbortController();
  const generate = options.generate ?? requestGeneratedThreadTitle;

  void generate(options.userMessage, controller.signal)
    .then(title => {
      if (
        controller.signal.aborted ||
        !title ||
        options.getCurrentTitle() !== options.expectedTitle
      ) {
        return;
      }
      options.applyTitle(title);
    })
    .catch(() => {})
    .finally(() => options.onSettled?.());

  return { cancel: () => controller.abort() };
}
