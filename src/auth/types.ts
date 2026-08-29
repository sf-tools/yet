export type OpenAIApiKeyAuth = {
  version: 1;
  provider: 'openai';
  method: 'api-key';
  apiKey: string;
  updatedAt: string;
};

export type OpenAIOAuthAuth = {
  version: 1;
  provider: 'openai';
  method: 'oauth';
  accessToken: string;
  refreshToken: string;
  idToken: string;
  accountId: string;
  email?: string;
  plan?: string;
  expiresAt?: number;
  fedramp?: boolean;
  updatedAt: string;
};

export type StoredOpenAIAuth = OpenAIApiKeyAuth | OpenAIOAuthAuth;

export type OpenAIAuthSummary = {
  method: 'api-key' | 'oauth';
  email?: string;
  plan?: string;
};

export type OpenAIConnection = {
  apiKey: string;
  cacheKey: string;
  baseURL?: string;
  defaultHeaders?: Record<string, string>;
};

export type OpenAIBrowserLoginProgress = {
  authorizationUrl: string;
  browserOpened: boolean;
};

export type OpenAILogoutResult = {
  loggedOut: boolean;
  revocationFailed: boolean;
};
