import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentApp } from '@/agent/app';
import {
  getOpenAIAuthSummary,
  loginOpenAIWithApiKey,
  loginOpenAIWithBrowser,
  logoutOpenAI,
  resolveOpenAIConnection,
} from '@/auth';
import { loadStoredOpenAIAuth, saveStoredOpenAIAuth } from '@/auth/storage';
import { renderOpenAILoginScreen } from '@/auth/onboarding';
import { createRenderContext } from '@/render';
import { createAgentStore } from '@/store';
import { createTheme } from '@/theme';
import type { TextPromptRequest } from '@/types';
import { check, equal, rejects } from './harness';

function jwt(payload: Record<string, unknown>) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return [
    encode({ alg: 'none' }),
    encode(payload),
    'signature',
  ].join('.');
}

const authHome = await mkdtemp(join(tmpdir(), 'yet-auth-test-'));
const apiKeyPath = join(authHome, 'api-key.json');
const previousEnvironmentKey = process.env.OPENAI_API_KEY;
const previousShortEnvironmentKey = process.env.OPENAI_KEY;
delete process.env.OPENAI_API_KEY;
delete process.env.OPENAI_KEY;

try {
  await loginOpenAIWithApiKey('  sk-test-secret  ', apiKeyPath);
  const storedApiKey = await loadStoredOpenAIAuth(apiKeyPath);
  check(storedApiKey?.method === 'api-key', 'API-key login stores an OpenAI API-key credential');
  if (storedApiKey?.method === 'api-key')
    equal(storedApiKey.apiKey, 'sk-test-secret', 'API-key login trims surrounding whitespace');
  if (process.platform !== 'win32')
    equal((await stat(apiKeyPath)).mode & 0o777, 0o600, 'the Yet auth file is private');
  check(!(await readFile(apiKeyPath, 'utf8')).includes(previousEnvironmentKey ?? '__absent__'), 'the auth file contains only the selected credential');

  const apiConnection = await resolveOpenAIConnection({ authPath: apiKeyPath });
  equal(apiConnection.apiKey, 'sk-test-secret', 'saved API-key login is used for OpenAI requests');
  equal(apiConnection.baseURL, undefined, 'API-key login uses the standard OpenAI API');
  equal((await getOpenAIAuthSummary(apiKeyPath))?.method, 'api-key', 'saved API-key login is reported as active');

  const oauthPath = join(authHome, 'oauth.json');
  const idToken = jwt({
    email: 'dev@example.com',
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'account-test',
      chatgpt_plan_type: 'plus',
    },
  });
  const accessToken = jwt({ exp: Math.floor(Date.now() / 1000) + 3_600 });
  let authorizationUrl = '';
  let exchangedVerifier = '';
  const oauthFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (!url.endsWith('/oauth/token')) throw new Error(`unexpected OAuth request: ${url}`);
    const body = init?.body as URLSearchParams;
    exchangedVerifier = body.get('code_verifier') ?? '';
    return new Response(JSON.stringify({
      access_token: accessToken,
      refresh_token: 'refresh-test',
      id_token: idToken,
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  const oauth = await loginOpenAIWithBrowser({
    authPath: oauthPath,
    issuer: 'https://auth.example.test',
    ports: [0],
    fetch: oauthFetch,
    openBrowser: url => {
      authorizationUrl = url;
      const authorize = new URL(url);
      const callback = new URL(authorize.searchParams.get('redirect_uri')!);
      callback.searchParams.set('code', 'authorization-code');
      callback.searchParams.set('state', authorize.searchParams.get('state')!);
      setTimeout(() => { void fetch(callback); }, 0);
      return true;
    },
    timeoutMs: 5_000,
  });
  equal(oauth.accountId, 'account-test', 'browser login records the ChatGPT account ID');
  equal(oauth.email, 'dev@example.com', 'browser login records the display identity');
  check(exchangedVerifier.length > 40, 'browser login exchanges the authorization code with its PKCE verifier');
  const authorize = new URL(authorizationUrl);
  equal(authorize.searchParams.get('code_challenge_method'), 'S256', 'browser login uses PKCE S256');
  check(authorize.searchParams.get('scope')?.includes('offline_access'), 'browser login requests refresh access');

  const oauthConnection = await resolveOpenAIConnection({ authPath: oauthPath });
  equal(oauthConnection.baseURL, 'https://chatgpt.com/backend-api/codex', 'ChatGPT login uses the Codex backend');
  equal(oauthConnection.defaultHeaders?.['ChatGPT-Account-ID'], 'account-test', 'ChatGPT requests include the selected account');
  equal((await getOpenAIAuthSummary(oauthPath))?.method, 'oauth', 'auth status identifies ChatGPT login');

  const refreshedAccessToken = jwt({ exp: Math.floor(Date.now() / 1000) + 7_200 });
  await saveStoredOpenAIAuth({
    ...oauth,
    accessToken: jwt({ exp: Math.floor(Date.now() / 1000) - 60 }),
    expiresAt: Date.now() - 60_000,
  }, oauthPath);
  let refreshedWith = '';
  const refreshedConnection = await resolveOpenAIConnection({
    authPath: oauthPath,
    issuer: 'https://auth.example.test',
    fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
      refreshedWith = String(JSON.parse(String(init?.body)).refresh_token);
      return new Response(JSON.stringify({ access_token: refreshedAccessToken }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch,
  });
  equal(refreshedWith, 'refresh-test', 'expired ChatGPT login refreshes with its refresh token');
  equal(refreshedConnection.apiKey, refreshedAccessToken, 'OpenAI requests use the refreshed access token');

  let revokedToken = '';
  const logoutResult = await logoutOpenAI({
    authPath: oauthPath,
    issuer: 'https://auth.example.test',
    fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
      revokedToken = String(JSON.parse(String(init?.body)).token);
      return new Response('', { status: 200 });
    }) as typeof fetch,
  });
  check(logoutResult.loggedOut, 'logout removes a saved OpenAI login');
  equal(revokedToken, 'refresh-test', 'logout revokes the OAuth refresh token');
  equal(await loadStoredOpenAIAuth(oauthPath), null, 'logout deletes the Yet auth file');

  process.env.OPENAI_API_KEY = 'sk-environment-test';
  process.env.OPENAI_KEY = 'sk-short-environment-test';
  const missingAuthPath = join(authHome, 'missing.json');
  await rejects(
    resolveOpenAIConnection({ authPath: missingAuthPath }),
    /Not logged in to OpenAI\. Run \/login\./,
    'environment API keys never authenticate Yet',
  );
  equal(await getOpenAIAuthSummary(missingAuthPath), null, 'environment API keys do not change login status');

  const pickScreen = renderOpenAILoginScreen({ view: 'pick', selected: 0 }, 100);
  check(pickScreen.includes('Welcome to Yet'), 'signed-out startup uses the Codex welcome layout');
  check(pickScreen.includes('Sign in with ChatGPT') && pickScreen.includes('Provide your own API key'), 'startup login shows both explicit methods');
  const apiKeyScreen = renderOpenAILoginScreen({
    view: 'api-key', value: 'sk-never-render-this', saving: false,
  }, 100);
  check(!apiKeyScreen.includes('sk-never-render-this'), 'startup API-key entry masks the credential');
  check(apiKeyScreen.includes('••••••••••••••••••••'), 'startup API-key entry preserves visible input length');

  const secretApp = new AgentApp({ initialState: createAgentStore().getState() });
  const secretInternals = secretApp as unknown as {
    store: ReturnType<typeof createAgentStore>;
    renderTransientLines(context: ReturnType<typeof createRenderContext>, suggestions: []): string[];
  };
  const secretPrompt: TextPromptRequest = {
    title: 'Enter API key',
    detail: 'Hidden',
    initialValue: '',
    secret: true,
  };
  secretInternals.store.replaceInput('sk-visible-secret');
  secretInternals.store.setPendingTextPrompt(secretPrompt);
  const secretRender = secretInternals.renderTransientLines(
    createRenderContext(createTheme(), false, 100, 20),
    [],
  ).join('\n');
  check(!secretRender.includes('sk-visible-secret'), 'secret text prompts never render their value');
  check(secretRender.includes('•••••••••••••••••'), 'secret text prompts render masked characters');
} finally {
  if (previousEnvironmentKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = previousEnvironmentKey;
  if (previousShortEnvironmentKey === undefined) delete process.env.OPENAI_KEY;
  else process.env.OPENAI_KEY = previousShortEnvironmentKey;
}
