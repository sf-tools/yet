import { EntryKind } from '@/types';
import type { OpenAIAuthSummary } from '@/auth';
import type { SlashCommand } from '../types';

function loginLabel(summary: OpenAIAuthSummary | null) {
  if (!summary) return 'Not signed in';
  if (summary.method === 'oauth') {
    const identity = summary.email ?? summary.plan;
    return `ChatGPT${identity ? ` · ${identity}` : ''}`;
  }
  return 'API key';
}

export const loginSlashCommand: SlashCommand = {
  name: 'login',
  description: 'Log in to OpenAI with ChatGPT or an API key.',
  showBusyIndicator: false,
  async execute(context, args) {
    if (args.argv.length > 0) throw new Error(`/${args.invocation} does not accept arguments`);

    const current = await context.getOpenAIAuthSummary();
    const selection = await context.requestChoice({
      title: 'Log in to OpenAI',
      detail: `Current: ${loginLabel(current)}`,
      recommendedValue: 'oauth',
      options: [
        {
          value: 'oauth',
          label: 'Sign in with ChatGPT',
          detail: 'Use your ChatGPT subscription',
        },
        {
          value: 'api-key',
          label: 'Use an API key',
          detail: 'Use usage-based OpenAI Platform billing',
        },
      ],
    });
    if (!selection) return;

    if (selection.value === 'api-key') {
      const apiKey = await context.requestTextInput({
        title: 'Enter your OpenAI API key',
        detail: 'The key is hidden and stored privately in ~/.yet/auth.json.',
        initialValue: '',
        placeholder: 'Paste API key',
        secret: true,
      });
      if (!apiKey) return;
      await context.loginOpenAIWithApiKey(apiKey);
      context.showFooterNotice('Logged in to OpenAI with an API key', 4_000);
      return;
    }

    let summary;
    try {
      summary = await context.loginOpenAIWithBrowser(progress => {
        context.printEntries([{
          type: 'entry',
          kind: EntryKind.Meta,
          text: progress.browserOpened
            ? 'Complete sign-in in your browser.'
            : `Open this URL to sign in:\n${progress.authorizationUrl}`,
        }]);
        context.showFooterNotice('Waiting for OpenAI sign-in…', 5 * 60 * 1000);
      });
    } catch (error) {
      context.showFooterNotice('OpenAI login failed', 4_000);
      throw error;
    }
    context.showFooterNotice(
      `Logged in with ChatGPT${summary.email ? ` as ${summary.email}` : ''}`,
      4_000,
    );
  },
};
