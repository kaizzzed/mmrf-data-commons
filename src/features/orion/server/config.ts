// BFF configuration (contract "Where records live" and "BFF environment"). Read per request, so
// a test or a redeploy changes it without a restart. Server-only.

export type OrionMode = 'L' | 'A' | 'H';

export interface LocalConfig {
  mode: 'L';
  /** The agent's origin; turns go to `<agentUrl>/invocations`. */
  agentUrl: URL;
  /** `${ORION_RUN_DIR}/runs/<runId>.json`, the volume the agent writes. */
  runDir: string;
}

export interface AwsConfig {
  mode: 'A' | 'H';
  region: string;
  runtimeArn: string;
  qualifier: string;
  runBucket: string;
  /** Used exactly as the writer uses it: the key is `${runPrefix}runs/<runId>.json`. */
  runPrefix: string;
  /** AgentCore data-plane origin; `AWS_ENDPOINT_URL_BEDROCK_AGENTCORE` overrides it. */
  agentCoreEndpoint: URL;
  /** Set only by `AWS_ENDPOINT_URL_S3`; the store then uses path-style URLs on that origin. */
  s3Endpoint: URL | null;
}

export type BffConfig = LocalConfig | AwsConfig;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export const DEFAULT_AGENT_URL = 'http://orion-agent:8080';
export const DEFAULT_RUN_DIR = '/data/runs';
export const DEFAULT_QUALIFIER = 'DEFAULT';
export const DEFAULT_REGION = 'us-east-1';
export const DEFAULT_RUN_PREFIX = 'orion/';

const RUNTIME_ARN = /^arn:aws[a-z-]*:bedrock-agentcore:[a-z0-9-]+:\d{12}:runtime\/[A-Za-z0-9_-]{1,100}$/;
const QUALIFIER = /^[A-Za-z0-9_-]{1,100}$/;
const REGION = /^[a-z]{2}(-[a-z]+)+-\d$/;
// S3 bucket naming rules (lowercase, digits, dots and hyphens; 3 to 63 characters).
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const PREFIX = /^[A-Za-z0-9!_.*'()/-]*$/;

type Env = Readonly<Record<string, string | undefined>>;

const value = (env: Env, name: string): string | undefined => {
  const raw = env[name];
  return raw === undefined || raw.trim() === '' ? undefined : raw.trim();
};

/** An origin, optionally followed by a path that is kept (no query, fragment or credentials). */
const parseOrigin = (raw: string, name: string): URL => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`${name} is not a URL`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new ConfigError(`${name} must be an http(s) URL without credentials, query or fragment`);
  }
  return url;
};

/** Accepts the origin the contract names, and tolerates a value that already ends in /invocations. */
const parseAgentUrl = (raw: string): URL => {
  const url = parseOrigin(raw, 'ORION_AGENT_URL');
  url.pathname = url.pathname.replace(/\/invocations\/?$/, '').replace(/\/+$/, '') || '/';
  return url;
};

export const readMode = (env: Env = process.env): OrionMode => {
  const mode = value(env, 'ORION_MODE') ?? 'L';
  if (mode !== 'L' && mode !== 'A' && mode !== 'H') throw new ConfigError('ORION_MODE must be L, A or H');
  return mode;
};

export const readConfig = (env: Env = process.env): BffConfig => {
  const mode = readMode(env);
  if (mode === 'L') {
    return {
      mode,
      agentUrl: parseAgentUrl(value(env, 'ORION_AGENT_URL') ?? DEFAULT_AGENT_URL),
      runDir: value(env, 'ORION_RUN_DIR') ?? DEFAULT_RUN_DIR,
    };
  }
  const region = value(env, 'AWS_REGION') ?? DEFAULT_REGION;
  if (!REGION.test(region)) throw new ConfigError('AWS_REGION is not a region name');
  const runtimeArn = value(env, 'ORION_RUNTIME_ARN');
  if (!runtimeArn || !RUNTIME_ARN.test(runtimeArn)) {
    throw new ConfigError('ORION_RUNTIME_ARN must be an AgentCore runtime ARN');
  }
  const qualifier = value(env, 'ORION_RUNTIME_QUALIFIER') ?? DEFAULT_QUALIFIER;
  if (!QUALIFIER.test(qualifier)) throw new ConfigError('ORION_RUNTIME_QUALIFIER is not a qualifier');
  const runBucket = value(env, 'ORION_RUN_BUCKET');
  if (!runBucket || !BUCKET.test(runBucket)) throw new ConfigError('ORION_RUN_BUCKET must be an S3 bucket name');
  // An explicitly empty prefix is allowed (records at the bucket root); unset means the default.
  const runPrefix = env.ORION_RUN_PREFIX === undefined ? DEFAULT_RUN_PREFIX : env.ORION_RUN_PREFIX.trim();
  if (!PREFIX.test(runPrefix) || runPrefix.startsWith('/')) {
    throw new ConfigError('ORION_RUN_PREFIX may hold only S3-safe key characters and must not start with /');
  }
  const agentCore = value(env, 'AWS_ENDPOINT_URL_BEDROCK_AGENTCORE');
  const s3 = value(env, 'AWS_ENDPOINT_URL_S3');
  return {
    mode,
    region,
    runtimeArn,
    qualifier,
    runBucket,
    runPrefix,
    agentCoreEndpoint: agentCore
      ? parseOrigin(agentCore, 'AWS_ENDPOINT_URL_BEDROCK_AGENTCORE')
      : new URL(`https://bedrock-agentcore.${region}.amazonaws.com`),
    s3Endpoint: s3 ? parseOrigin(s3, 'AWS_ENDPOINT_URL_S3') : null,
  };
};
