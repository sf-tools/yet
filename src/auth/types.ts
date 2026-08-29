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

export type OpenAIUsageWindow = {
  kind: 'primary' | 'secondary';
  usedPercent: number;
  windowMinutes?: number;
  resetsAt?: number;
};

export type OpenAIUsageBucket = {
  name: string;
  windows: OpenAIUsageWindow[];
};

export type OpenAIUsageCredits = {
  hasCredits: boolean;
  unlimited: boolean;
  balance?: string;
};

export type OpenAIUsageSpendLimit = {
  usedPercent: number;
  remainingPercent: number;
  used: string;
  limit: string;
  resetsAt?: number;
};

export type OpenAIUsageSnapshot = {
  plan?: string;
  buckets: OpenAIUsageBucket[];
  credits?: OpenAIUsageCredits;
  spendLimit?: OpenAIUsageSpendLimit;
};
