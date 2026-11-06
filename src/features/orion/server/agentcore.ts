// AgentCore Runtime data plane (service `bedrock-agentcore`, rest-json): InvokeAgentRuntime and
// StopRuntimeSession, as botocore's bedrock-agentcore model (API 2024-02-28) defines them.

import { randomUUID } from 'node:crypto';
import { RUNTIME_SESSION_HEADER } from '../agui/types';
import type { AwsConfig } from './config';
import { readSnippet, sendRequest } from './httpClient';
import type { CredentialProvider } from './credentials';
import { signRequest, uriEncode } from './sigv4';

export const AGENTCORE_SERVICE = 'bedrock-agentcore';

export interface PreparedRequest {
  method: 'GET' | 'POST';
  url: URL;
  /** Unsigned headers; `signPrepared` adds the signature. */
  headers: Record<string, string>;
  body: Buffer;
}

const runtimeUrl = (config: Pick<AwsConfig, 'agentCoreEndpoint' | 'runtimeArn' | 'qualifier'>, op: string): URL => {
  const url = new URL(config.agentCoreEndpoint.href);
  const base = url.pathname.replace(/\/+$/, '');
  url.pathname = `${base}/runtimes/${uriEncode(config.runtimeArn)}/${op}`;
  url.search = `?qualifier=${uriEncode(config.qualifier)}`;
  return url;
};

export interface InvokeInput {
  sessionId: string;
  /** The browser's RunAgentInput bytes, sent unchanged as `payload`. */
  body: Buffer;
  traceparent: string | null;
}

/** POST /runtimes/{arn}/invocations?qualifier=…, the turn's bytes as the payload. */
export const invokeAgentRuntimeRequest = (
  config: Pick<AwsConfig, 'agentCoreEndpoint' | 'runtimeArn' | 'qualifier'>,
  { sessionId, body, traceparent }: InvokeInput,
): PreparedRequest => ({
  method: 'POST',
  url: runtimeUrl(config, 'invocations'),
  headers: {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    [RUNTIME_SESSION_HEADER]: sessionId,
    ...(traceparent ? { traceparent } : {}),
  },
  body,
});

/** POST /runtimes/{arn}/stopruntimesession?qualifier=…, body `{"clientToken"}` (idempotency token). */
export const stopRuntimeSessionRequest = (
  config: Pick<AwsConfig, 'agentCoreEndpoint' | 'runtimeArn' | 'qualifier'>,
  sessionId: string,
  clientToken: string = randomUUID(),
): PreparedRequest => ({
  method: 'POST',
  url: runtimeUrl(config, 'stopruntimesession'),
  headers: { 'Content-Type': 'application/json', [RUNTIME_SESSION_HEADER]: sessionId },
  body: Buffer.from(JSON.stringify({ clientToken })),
});

export const signPrepared = (
  prepared: PreparedRequest,
  { region, credentials, now, service = AGENTCORE_SERVICE, s3 = false }: {
    region: string;
    credentials: Awaited<ReturnType<CredentialProvider>>;
    now: Date;
    service?: string;
    s3?: boolean;
  },
): Record<string, string> =>
  signRequest({
    method: prepared.method,
    url: prepared.url,
    headers: prepared.headers,
    body: prepared.body,
    service,
    region,
    credentials,
    now,
    s3,
  }).headers;

export type StopOutcome = { ok: true; status: number } | { ok: false; status: number | null; reason: string };

const STOP_TIMEOUT_MS = 10_000;

/** Calls StopRuntimeSession; never throws (the caller only logs the outcome). */
export const stopRuntimeSession = async (
  config: AwsConfig,
  sessionId: string,
  credentials: CredentialProvider,
  now: () => Date = () => new Date(),
): Promise<StopOutcome> => {
  try {
    const prepared = stopRuntimeSessionRequest(config, sessionId);
    const headers = signPrepared(prepared, { region: config.region, credentials: await credentials(), now: now() });
    const response = await sendRequest({
      url: prepared.url,
      method: prepared.method,
      headers,
      body: prepared.body,
      headersTimeoutMs: STOP_TIMEOUT_MS,
    });
    const status = response.statusCode ?? 0;
    if (status >= 200 && status < 300) {
      response.resume();
      return { ok: true, status };
    }
    const errorType = String(response.headers['x-amzn-errortype'] ?? '').split(':')[0];
    await readSnippet(response);
    return { ok: false, status, reason: errorType || `HTTP ${status}` };
  } catch (err) {
    return { ok: false, status: null, reason: err instanceof Error ? err.name : 'error' };
  }
};
