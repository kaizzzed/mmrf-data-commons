// AWS credentials for modes A and H (contract: the developer profile in H, the `orion-bff` Pod
// Identity role in A). Two sources, in the AWS SDK's order: environment keys, then the container
// credential endpoint that EKS Pod Identity and ECS set up. Values are never logged.

import { readFile } from 'node:fs/promises';
import { readBody, sendRequest } from './httpClient';
import type { AwsCredentials } from './sigv4';

export type CredentialProvider = () => Promise<AwsCredentials>;

export class CredentialsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialsError';
  }
}

type Env = Readonly<Record<string, string | undefined>>;

const set = (raw: string | undefined): string | undefined => (raw && raw.trim() ? raw.trim() : undefined);

/** AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY (and AWS_SESSION_TOKEN), or null when either is unset. */
export const envCredentials = (env: Env = process.env): AwsCredentials | null => {
  const accessKeyId = set(env.AWS_ACCESS_KEY_ID);
  const secretAccessKey = set(env.AWS_SECRET_ACCESS_KEY);
  if (!accessKeyId || !secretAccessKey) return null;
  const sessionToken = set(env.AWS_SESSION_TOKEN);
  return sessionToken ? { accessKeyId, secretAccessKey, sessionToken } : { accessKeyId, secretAccessKey };
};

/** The ECS task endpoint that AWS_CONTAINER_CREDENTIALS_RELATIVE_URI is relative to. */
export const ECS_CONTAINER_HOST = 'http://169.254.170.2';
/** Plain HTTP is allowed only to these hosts (the AWS SDKs' rule); any host over HTTPS. */
const LINK_LOCAL_HOSTS: ReadonlySet<string> = new Set(['169.254.170.2', '169.254.170.23', '[fd00:ec2::23]']);
const isLoopback = (host: string): boolean =>
  host === 'localhost' || host === '[::1]' || /^127(\.\d{1,3}){3}$/.test(host);

export interface ContainerSource {
  url: URL;
  /** Read again on every refresh: the Pod Identity token rotates. */
  tokenFile?: string;
  token?: string;
}

export const containerSource = (env: Env = process.env): ContainerSource | null => {
  const full = set(env.AWS_CONTAINER_CREDENTIALS_FULL_URI);
  const relative = set(env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI);
  if (!full && !relative) return null;
  let url: URL;
  try {
    url = relative ? new URL(relative, ECS_CONTAINER_HOST) : new URL(full as string);
  } catch {
    throw new CredentialsError('The container credentials URI is not a URL');
  }
  if (url.protocol === 'http:') {
    if (!isLoopback(url.hostname) && !LINK_LOCAL_HOSTS.has(url.host) && !LINK_LOCAL_HOSTS.has(url.hostname)) {
      throw new CredentialsError('The container credentials URI must be HTTPS or a loopback or link-local host');
    }
  } else if (url.protocol !== 'https:') {
    throw new CredentialsError('The container credentials URI must use HTTP or HTTPS');
  }
  return {
    url,
    tokenFile: set(env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE),
    token: set(env.AWS_CONTAINER_AUTHORIZATION_TOKEN),
  };
};

/** Refresh this long before expiry, as the SDKs do. */
export const REFRESH_MARGIN_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 2_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

interface ContainerResponse {
  AccessKeyId?: unknown;
  SecretAccessKey?: unknown;
  Token?: unknown;
  Expiration?: unknown;
}

const fetchContainerCredentials = async (source: ContainerSource): Promise<AwsCredentials> => {
  let token = source.token;
  if (source.tokenFile) {
    try {
      token = (await readFile(source.tokenFile, 'utf8')).trim();
    } catch {
      throw new CredentialsError('The container authorization token file cannot be read');
    }
  }
  if (token !== undefined && /[\r\n]/.test(token)) {
    throw new CredentialsError('The container authorization token is not a header value');
  }
  const response = await sendRequest({
    url: source.url,
    method: 'GET',
    headers: { Accept: 'application/json', ...(token ? { Authorization: token } : {}) },
    headersTimeoutMs: FETCH_TIMEOUT_MS,
  }).catch(() => {
    throw new CredentialsError('The container credentials endpoint is unreachable');
  });
  const body = await readBody(response, MAX_RESPONSE_BYTES).catch(() => {
    throw new CredentialsError('The container credentials response could not be read');
  });
  if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) > 299) {
    throw new CredentialsError(`The container credentials endpoint answered HTTP ${response.statusCode}`);
  }
  let parsed: ContainerResponse;
  try {
    parsed = JSON.parse(body.toString('utf8')) as ContainerResponse;
  } catch {
    throw new CredentialsError('The container credentials response is not JSON');
  }
  const { AccessKeyId, SecretAccessKey, Token, Expiration } = parsed;
  if (typeof AccessKeyId !== 'string' || !AccessKeyId || typeof SecretAccessKey !== 'string' || !SecretAccessKey) {
    throw new CredentialsError('The container credentials response has no keys');
  }
  const expiration = typeof Expiration === 'string' ? new Date(Expiration) : undefined;
  if (expiration && Number.isNaN(expiration.getTime())) {
    throw new CredentialsError('The container credentials expiration is not a date');
  }
  return {
    accessKeyId: AccessKeyId,
    secretAccessKey: SecretAccessKey,
    ...(typeof Token === 'string' && Token ? { sessionToken: Token } : {}),
    ...(expiration ? { expiration } : {}),
  };
};

/**
 * Caches the endpoint's credentials until REFRESH_MARGIN_MS before they expire (credentials
 * without an expiration for one minute), with one fetch in flight at a time.
 */
export const containerCredentialProvider = (
  source: ContainerSource,
  now: () => number = Date.now,
): CredentialProvider => {
  let cached: { credentials: AwsCredentials; refreshAt: number } | null = null;
  let pending: Promise<AwsCredentials> | null = null;
  return async () => {
    if (cached && now() < cached.refreshAt) return cached.credentials;
    pending ??= fetchContainerCredentials(source)
      .then((credentials) => {
        const expires = credentials.expiration?.getTime();
        cached = {
          credentials,
          refreshAt: expires === undefined ? now() + 60_000 : expires - REFRESH_MARGIN_MS,
        };
        return credentials;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  };
};

const containerProviders = new Map<string, CredentialProvider>();

/**
 * The default chain, resolved per call so a changed environment takes effect: environment keys
 * first, then the container endpoint (one cached provider per endpoint and token source).
 */
export const defaultCredentialProvider =
  (env: Env = process.env): CredentialProvider =>
  async () => {
    const fromEnv = envCredentials(env);
    if (fromEnv) return fromEnv;
    const source = containerSource(env);
    if (!source) {
      throw new CredentialsError(
        'No AWS credentials: set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, or run with Pod Identity',
      );
    }
    const key = `${source.url.href}\n${source.tokenFile ?? ''}\n${source.token ? 'token' : ''}`;
    let provider = containerProviders.get(key);
    if (!provider) {
      provider = containerCredentialProvider(source);
      containerProviders.set(key, provider);
    }
    return provider();
  };
