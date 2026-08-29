import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';

import {
  deleteStoredOpenAIAuth,
  loadStoredOpenAIAuth,
  saveStoredOpenAIAuth,
  YET_AUTH_PATH,
} from './storage';
import type {
  OpenAIAuthSummary,
  OpenAIBrowserLoginProgress,
  OpenAIConnection,
  OpenAILogoutResult,
  OpenAIOAuthAuth,
  StoredOpenAIAuth,
} from './types';

const OPENAI_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const OPENAI_AUTH_ISSUER = 'https://auth.openai.com';
const OPENAI_CHATGPT_BASE_URL = 'https://chatgpt.com/backend-api/codex';
const OAUTH_CALLBACK_PORTS = [1455, 1457] as const;
const OAUTH_SCOPE = 'openid profile email offline_access api.connectors.read api.connectors.invoke';
const REFRESH_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

type OAuthTokenResponse = {
  access_token?: unknown;
  refresh_token?: unknown;
  id_token?: unknown;
  expires_in?: unknown;
};

type BrowserLoginOptions = {
  authPath?: string;
  issuer?: string;
  ports?: readonly number[];
  fetch?: typeof fetch;
  openBrowser?: (url: string) => boolean | Promise<boolean>;
  onProgress?: (progress: OpenAIBrowserLoginProgress) => void;
  timeoutMs?: number;
  signal?: AbortSignal;
};

type RefreshOptions = {
  authPath?: string;
  issuer?: string;
  fetch?: typeof fetch;
};

function nonempty(value: unknown, label: string) {
  if (typeof value !== 'string' || value.trim().length === 0)
    throw new Error(`OpenAI OAuth response did not include ${label}`);
  return value;
}

function base64Url(bytes: Uint8Array) {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) throw new Error('OpenAI returned an invalid ID token');
  try {
    const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const value = JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as unknown;
    if (!value || typeof value !== 'object') throw new Error('invalid payload');
    return value as Record<string, unknown>;
  } catch {
    throw new Error('OpenAI returned an invalid ID token');
  }
}

function tokenExpiration(token: string) {
  try {
    const exp = decodeJwtPayload(token).exp;
    return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

function oauthMetadata(idToken: string) {
  const payload = decodeJwtPayload(idToken);
  const profile = payload['https://api.openai.com/profile'];
  const auth = payload['https://api.openai.com/auth'];
  const profileClaims = profile && typeof profile === 'object' ? profile as Record<string, unknown> : {};
  const authClaims = auth && typeof auth === 'object' ? auth as Record<string, unknown> : {};
  const accountId = authClaims.chatgpt_account_id;
  if (typeof accountId !== 'string' || accountId.length === 0)
    throw new Error('OpenAI login did not return a ChatGPT account');
  const email = typeof payload.email === 'string'
    ? payload.email
    : typeof profileClaims.email === 'string' ? profileClaims.email : undefined;
  return {
    accountId,
    ...(email ? { email } : {}),
    ...(typeof authClaims.chatgpt_plan_type === 'string'
      ? { plan: authClaims.chatgpt_plan_type }
      : {}),
    ...(authClaims.chatgpt_account_is_fedramp === true ? { fedramp: true } : {}),
  };
}

function createStoredOAuth(tokens: OAuthTokenResponse): OpenAIOAuthAuth {
  const accessToken = nonempty(tokens.access_token, 'an access token');
  const refreshToken = nonempty(tokens.refresh_token, 'a refresh token');
  const idToken = nonempty(tokens.id_token, 'an ID token');
  const jwtExpiresAt = tokenExpiration(accessToken);
  const responseExpiresAt = typeof tokens.expires_in === 'number' && tokens.expires_in > 0
    ? Date.now() + tokens.expires_in * 1000
    : undefined;
  return {
    version: 1,
    provider: 'openai',
    method: 'oauth',
    accessToken,
    refreshToken,
    idToken,
    ...oauthMetadata(idToken),
    ...(jwtExpiresAt ?? responseExpiresAt ? { expiresAt: jwtExpiresAt ?? responseExpiresAt } : {}),
    updatedAt: new Date().toISOString(),
  };
}

async function responseError(response: Response) {
  const text = await response.text().catch(() => '');
  if (text) {
    try {
      const value = JSON.parse(text) as { error_description?: unknown; error?: unknown };
      const detail = typeof value.error_description === 'string'
        ? value.error_description
        : typeof value.error === 'string' ? value.error : null;
      if (detail) return detail;
    } catch {}
  }
  return `HTTP ${response.status}`;
}

async function exchangeAuthorizationCode(
  code: string,
  redirectUri: string,
  verifier: string,
  issuer: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: OPENAI_OAUTH_CLIENT_ID,
    code_verifier: verifier,
  });
  const response = await fetchImpl(`${issuer.replace(/\/$/, '')}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal,
  });
  if (!response.ok) throw new Error(`OpenAI login failed: ${await responseError(response)}`);
  return createStoredOAuth(await response.json() as OAuthTokenResponse);
}

function html(message: string) {
  const escaped = message.replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character] ?? character);
  return `<!doctype html><meta charset="utf-8"><body style="font-family: Arial, sans-serif">${escaped}</body>`;
}

async function listen(server: Server, ports: readonly number[]) {
  for (const port of ports) {
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => { cleanup(); reject(error); };
        const onListening = () => { cleanup(); resolve(); };
        const cleanup = () => {
          server.off('error', onError);
          server.off('listening', onListening);
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, '127.0.0.1');
      });
      const address = server.address();
      return typeof address === 'object' && address ? address.port : port;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error(`OpenAI login could not start because callback ports ${ports.join(' and ')} are in use`);
}

export function openLoginUrl(url: string) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    // Ant can emit ChildProcess's `spawn` event synchronously, before a caller
    // can attach a listener. The PID is already populated when launch succeeds,
    // so do not make OAuth completion depend on observing that event.
    const opened = typeof child.pid === 'number';
    child.once('error', () => {});
    child.unref();
    return Promise.resolve(opened);
  } catch {
    return Promise.resolve(false);
  }
}

export async function loginOpenAIWithApiKey(apiKey: string, authPath = YET_AUTH_PATH) {
  const normalized = apiKey.trim();
  if (!normalized || /[\r\n]/.test(normalized)) throw new Error('Enter a valid OpenAI API key');
  await saveStoredOpenAIAuth({
    version: 1,
    provider: 'openai',
    method: 'api-key',
    apiKey: normalized,
    updatedAt: new Date().toISOString(),
  }, authPath);
}

export async function loginOpenAIWithBrowser(options: BrowserLoginOptions = {}) {
  if (options.signal?.aborted) throw new Error('OpenAI login cancelled');
  const issuer = (options.issuer ?? OPENAI_AUTH_ISSUER).replace(/\/$/, '');
  const fetchImpl = options.fetch ?? fetch;
  const verifier = base64Url(randomBytes(64));
  const challenge = base64Url(createHash('sha256').update(verifier).digest());
  const state = base64Url(randomBytes(32));
  let redirectUri = '';
  let settled = false;
  let finish!: (auth: OpenAIOAuthAuth) => void;
  let fail!: (error: Error) => void;
  const completion = new Promise<OpenAIOAuthAuth>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', redirectUri || 'http://localhost');
      if (request.method !== 'GET' || url.pathname !== '/auth/callback') {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('Not found');
        return;
      }
      if (url.searchParams.get('state') !== state) {
        response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('State mismatch');
        return;
      }
      const oauthError = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      if (oauthError || !code) {
        const detail = url.searchParams.get('error_description') || oauthError || 'missing authorization code';
        response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
        response.end(html(`OpenAI login failed: ${detail}`));
        if (!settled) { settled = true; fail(new Error(`OpenAI login failed: ${detail}`)); }
        return;
      }
      try {
        const auth = await exchangeAuthorizationCode(
          code,
          redirectUri,
          verifier,
          issuer,
          fetchImpl,
          options.signal,
        );
        if (settled) {
          response.writeHead(410, { 'content-type': 'text/plain; charset=utf-8' });
          response.end('Login cancelled');
          return;
        }
        await saveStoredOpenAIAuth(auth, options.authPath ?? YET_AUTH_PATH);
        response.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          connection: 'close',
        });
        response.once('finish', () => {
          if (!settled) { settled = true; finish(auth); }
        });
        response.end(html('Signed in to Yet.dev using OpenAI'));
      } catch (error) {
        const safeMessage = error instanceof Error ? error.message : 'OpenAI login failed';
        response.writeHead(500, { 'content-type': 'text/html; charset=utf-8' });
        response.end(html(safeMessage));
        if (!settled) { settled = true; fail(error instanceof Error ? error : new Error(safeMessage)); }
      }
    })();
  });

  const port = await listen(server, options.ports ?? OAUTH_CALLBACK_PORTS);
  redirectUri = `http://localhost:${port}/auth/callback`;
  const authorizeUrl = new URL(`${issuer}/oauth/authorize`);
  for (const [key, value] of Object.entries({
    response_type: 'code',
    client_id: OPENAI_OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: OAUTH_SCOPE,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    state,
    originator: 'codex_cli_rs',
  })) authorizeUrl.searchParams.set(key, value);

  const browserOpened = await (options.openBrowser ?? openLoginUrl)(authorizeUrl.toString());
  options.onProgress?.({ authorizationUrl: authorizeUrl.toString(), browserOpened });
  const timeout = setTimeout(() => {
    if (!settled) { settled = true; fail(new Error('OpenAI login timed out')); }
  }, options.timeoutMs ?? LOGIN_TIMEOUT_MS);
  timeout.unref();
  const onAbort = () => {
    if (!settled) { settled = true; fail(new Error('OpenAI login cancelled')); }
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    return await completion;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', onAbort);
    server.close();
    server.closeAllConnections?.();
  }
}

let refreshInFlight: Promise<OpenAIOAuthAuth> | null = null;

async function refreshOAuth(auth: OpenAIOAuthAuth, options: RefreshOptions = {}) {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const issuer = (options.issuer ?? OPENAI_AUTH_ISSUER).replace(/\/$/, '');
    const response = await (options.fetch ?? fetch)(`${issuer}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: OPENAI_OAUTH_CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: auth.refreshToken,
      }),
    });
    if (!response.ok)
      throw new Error(`OpenAI session refresh failed: ${await responseError(response)}. Run /login again.`);
    const tokens = await response.json() as OAuthTokenResponse;
    const next = createStoredOAuth({
      access_token: tokens.access_token,
      refresh_token: typeof tokens.refresh_token === 'string' ? tokens.refresh_token : auth.refreshToken,
      id_token: typeof tokens.id_token === 'string' ? tokens.id_token : auth.idToken,
      expires_in: tokens.expires_in,
    });
    await saveStoredOpenAIAuth(next, options.authPath ?? YET_AUTH_PATH);
    return next;
  })();
  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

async function currentStoredAuth(options: RefreshOptions = {}): Promise<StoredOpenAIAuth | null> {
  const auth = await loadStoredOpenAIAuth(options.authPath ?? YET_AUTH_PATH);
  if (auth?.method !== 'oauth') return auth;
  const expiresAt = auth.expiresAt ?? tokenExpiration(auth.accessToken);
  if (expiresAt === undefined || expiresAt > Date.now() + REFRESH_WINDOW_MS) return auth;
  return refreshOAuth(auth, options);
}

export async function resolveOpenAIConnection(options: RefreshOptions = {}): Promise<OpenAIConnection> {
  const auth = await currentStoredAuth(options);
  if (auth?.method === 'api-key') {
    return {
      apiKey: auth.apiKey,
      cacheKey: `api-key:${createHash('sha256').update(auth.apiKey).digest('hex')}`,
    };
  }
  if (auth?.method === 'oauth') {
    return {
      apiKey: auth.accessToken,
      cacheKey: `oauth:${createHash('sha256').update(auth.accessToken).digest('hex')}`,
      baseURL: OPENAI_CHATGPT_BASE_URL,
      defaultHeaders: {
        'ChatGPT-Account-ID': auth.accountId,
        originator: 'yet',
        ...(auth.fedramp ? { 'X-OpenAI-Fedramp': 'true' } : {}),
      },
    };
  }
  throw new Error('Not logged in to OpenAI. Run /login.');
}

export async function getOpenAIAuthSummary(authPath = YET_AUTH_PATH): Promise<OpenAIAuthSummary | null> {
  const auth = await loadStoredOpenAIAuth(authPath);
  if (auth?.method === 'oauth')
    return { method: 'oauth', ...(auth.email ? { email: auth.email } : {}), ...(auth.plan ? { plan: auth.plan } : {}) };
  if (auth?.method === 'api-key') return { method: 'api-key' };
  return null;
}

async function revokeOAuth(auth: OpenAIOAuthAuth, fetchImpl: typeof fetch, issuer: string) {
  const token = auth.refreshToken || auth.accessToken;
  const refresh = Boolean(auth.refreshToken);
  const response = await fetchImpl(`${issuer.replace(/\/$/, '')}/oauth/revoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      token,
      token_type_hint: refresh ? 'refresh_token' : 'access_token',
      ...(refresh ? { client_id: OPENAI_OAUTH_CLIENT_ID } : {}),
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`token revocation failed: ${await responseError(response)}`);
}

export async function logoutOpenAI(options: RefreshOptions = {}): Promise<OpenAILogoutResult> {
  const path = options.authPath ?? YET_AUTH_PATH;
  const auth = await loadStoredOpenAIAuth(path);
  let revocationFailed = false;
  if (auth?.method === 'oauth') {
    try {
      await revokeOAuth(auth, options.fetch ?? fetch, options.issuer ?? OPENAI_AUTH_ISSUER);
    } catch {
      revocationFailed = true;
    }
  }
  if (auth) await deleteStoredOpenAIAuth(path);
  return {
    loggedOut: auth !== null,
    revocationFailed,
  };
}
