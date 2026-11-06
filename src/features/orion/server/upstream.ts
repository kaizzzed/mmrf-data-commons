// The agent each mode's turns go to (contract "POST /api/orion/agui"): the orion-agent container
// in mode L, AgentCore InvokeAgentRuntime in modes A and H. Both carry the runtime session id
// `orion-<threadId>`, the browser's traceparent and the body bytes unchanged.

import type { IncomingMessage } from 'node:http';
import { RUNTIME_SESSION_HEADER, runtimeSessionId } from '../agui/types';
import { invokeAgentRuntimeRequest, signPrepared, stopRuntimeSession, type StopOutcome } from './agentcore';
import type { AwsConfig, LocalConfig } from './config';
import type { CredentialProvider } from './credentials';
import { sendRequest } from './httpClient';

export interface UpstreamTurn {
  threadId: string;
  body: Buffer;
  traceparent: string | null;
  /** Aborts the call (Stop, an edit or a confirm on the same thread); never a browser disconnect. */
  signal: AbortSignal;
}

export interface Upstream {
  /** Resolves when the response headers arrive; rejects when the call cannot be made or connect. */
  send(turn: UpstreamTurn): Promise<IncomingMessage>;
  /** StopRuntimeSession, modes A and H only. */
  stopSession?(threadId: string): Promise<StopOutcome>;
}

/** The call could not be made at all (no credentials); the route answers UPSTREAM_UNAVAILABLE. */
export class UpstreamSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpstreamSetupError';
  }
}

export const invocationsUrl = (agentUrl: URL): URL => {
  const url = new URL(agentUrl.href);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/invocations`;
  return url;
};

export const localUpstream = (config: Pick<LocalConfig, 'agentUrl'>): Upstream => ({
  send: ({ threadId, body, traceparent, signal }) =>
    sendRequest({
      url: invocationsUrl(config.agentUrl),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        [RUNTIME_SESSION_HEADER]: runtimeSessionId(threadId),
        ...(traceparent ? { traceparent } : {}),
      },
      body,
      signal,
    }),
});

export const agentCoreUpstream = (
  config: AwsConfig,
  credentials: CredentialProvider,
  now: () => Date = () => new Date(),
): Upstream => ({
  async send({ threadId, body, traceparent, signal }) {
    const prepared = invokeAgentRuntimeRequest(config, { sessionId: runtimeSessionId(threadId), body, traceparent });
    let resolved;
    try {
      resolved = await credentials();
    } catch (err) {
      throw new UpstreamSetupError(err instanceof Error ? err.message : 'No AWS credentials');
    }
    const headers = signPrepared(prepared, { region: config.region, credentials: resolved, now: now() });
    return sendRequest({ url: prepared.url, method: 'POST', headers, body: prepared.body, signal });
  },
  stopSession: (threadId) => stopRuntimeSession(config, runtimeSessionId(threadId), credentials, now),
});
