// The three BFF route handlers (contract "BFF routes"). The page modules under
// src/pages/api/orion/ bind them to the default dependencies (defaults.ts); tests bind fakes.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { isId } from '../ids';
import type { Authenticate } from './auth';
import { ConfigError, type BffConfig } from './config';
import type { CredentialProvider } from './credentials';
import { BffFailure, JSON_CONTENT_TYPE, methodNotAllowed, sendBffError } from './errors';
import { applyLeaseRule } from './leaseRule';
import { log } from './log';
import { answerRelayFailure, relayTurn, type RelayTimers } from './relay';
import { recordFilename } from './routes';
import { readTurn, traceparentOf, type Turn } from './runInput';
import type { SessionRegistry } from './sessions';
import { loadRecord, recordStoreFor, type RecordStore, type StoredRecord } from './store';
import { agentCoreUpstream, localUpstream, type Upstream } from './upstream';

/** What Next.js passes (NextApiRequest is one); `query` is optional so plain Node servers work too. */
export type RouteRequest = IncomingMessage & { query?: Partial<Record<string, string | string[]>> };
export type RouteHandler = (req: RouteRequest, res: ServerResponse) => Promise<void>;

export interface HandlerDeps {
  authenticate: Authenticate;
  /** Read per request; throws ConfigError when the deployment is misconfigured. */
  config: () => BffConfig;
  credentials: CredentialProvider;
  sessions: SessionRegistry;
  timers: RelayTimers;
  now: () => number;
  upstreamFor?: (config: BffConfig, credentials: CredentialProvider) => Upstream;
  storeFor?: (config: BffConfig, credentials: CredentialProvider) => RecordStore;
}

export const upstreamForConfig = (config: BffConfig, credentials: CredentialProvider): Upstream =>
  config.mode === 'L' ? localUpstream(config) : agentCoreUpstream(config, credentials);

const unauthenticated = (): BffFailure => new BffFailure('UNAUTHENTICATED', 'Sign in to use ORION.');

const loadConfig = (deps: HandlerDeps): BffConfig => {
  try {
    return deps.config();
  } catch (err) {
    if (err instanceof ConfigError) {
      log('error', 'config_invalid', { reason: err.message });
      throw new BffFailure('UPSTREAM_UNAVAILABLE', 'ORION is not configured on this server.');
    }
    throw err;
  }
};

const fail = (res: ServerResponse, err: unknown, route: string): void => {
  if (err instanceof BffFailure) {
    sendBffError(res, err);
    return;
  }
  log('error', 'route_failed', { route, reason: err instanceof Error ? err.name : 'error' });
  sendBffError(res, new BffFailure('UPSTREAM_ERROR', 'The request failed.'));
};

// ---------------------------------------------------------------- POST /api/orion/agui

export const createAguiHandler =
  (deps: HandlerDeps): RouteHandler =>
  async (req, res) => {
    if (req.method !== 'POST') {
      methodNotAllowed(res, 'POST');
      return;
    }
    let upstream: Upstream;
    let turn: Turn;
    try {
      if (!(await deps.authenticate(req))) throw unauthenticated();
      turn = await readTurn(req);
      const config = loadConfig(deps);
      upstream = (deps.upstreamFor ?? upstreamForConfig)(config, deps.credentials);
    } catch (err) {
      fail(res, err, 'agui');
      return;
    }
    try {
      await relayTurn(res, turn, traceparentOf(req), { upstream, sessions: deps.sessions, timers: deps.timers });
    } catch (err) {
      answerRelayFailure(res, err);
    }
  };

// ------------------------------------------------- GET /api/orion/runs/[runId]/{view,record}

const fromUrl = (req: RouteRequest): URL => new URL(req.url ?? '/', 'http://bff.invalid');

/** One query value: Next's parsed query when present, else the URL. Repeated values are invalid. */
const queryValue = (req: RouteRequest, name: string): string | null => {
  const raw = req.query ? req.query[name] : fromUrl(req).searchParams.getAll(name);
  if (raw === undefined) return null;
  if (Array.isArray(raw)) {
    if (raw.length === 0) return null;
    if (raw.length > 1) throw new BffFailure('INVALID_INPUT', `Give ${name} once.`);
    return raw[0];
  }
  return raw;
};

const RUN_PATH = /\/runs\/([^/]+)\/(?:view|record)\/?$/;

const runIdOf = (req: RouteRequest): string | null => {
  const fromQuery = req.query?.runId;
  if (typeof fromQuery === 'string') return fromQuery;
  const match = RUN_PATH.exec(fromUrl(req).pathname);
  return match ? decodeURIComponent(match[1]) : null;
};

interface ReadTarget {
  runId: string;
  threadId: string | null;
}

/** Ids first: runId from the path, the optional threadId from the query. */
const readTarget = (req: RouteRequest): ReadTarget => {
  const runId = runIdOf(req);
  if (!isId(runId)) throw new BffFailure('INVALID_INPUT', 'runId must be 32 lowercase hex characters.');
  const threadId = queryValue(req, 'threadId');
  if (threadId !== null && !isId(threadId)) {
    throw new BffFailure('INVALID_INPUT', 'threadId must be 32 lowercase hex characters.');
  }
  return { runId, threadId };
};

const NOT_FOUND = (): BffFailure => new BffFailure('RUN_NOT_FOUND', 'No stored run with this runId in this thread.');

const sendJson = (res: ServerResponse, body: Buffer, extra: Record<string, string> = {}): void => {
  res.writeHead(200, {
    'Content-Type': JSON_CONTENT_TYPE,
    'Content-Length': String(body.length),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  });
  res.end(body);
};

type Serve = (res: ServerResponse, req: RouteRequest, found: StoredRecord) => void;

const readHandler =
  (deps: HandlerDeps, route: 'view' | 'record', serve: Serve): RouteHandler =>
  async (req, res) => {
    if (req.method !== 'GET') {
      methodNotAllowed(res, 'GET');
      return;
    }
    try {
      if (!(await deps.authenticate(req))) throw unauthenticated();
      const { runId, threadId } = readTarget(req);
      const config = loadConfig(deps);
      const store = (deps.storeFor ?? recordStoreFor)(config, deps.credentials);
      const found = await loadRecord(store, runId, threadId);
      if (!found) throw NOT_FOUND();
      serve(res, req, found);
    } catch (err) {
      fail(res, err, route);
    }
  };

/**
 * GET /api/orion/runs/[runId]/view: the record's runView, untrimmed, with the expired-lease rule
 * applied. A record without a runView is RUN_NOT_FOUND.
 */
export const createViewHandler = (deps: HandlerDeps): RouteHandler =>
  readHandler(deps, 'view', (res, _req, { head }) => {
    if (head.runView === null) throw NOT_FOUND();
    const view = applyLeaseRule({ ...head, runView: head.runView }, deps.now());
    sendJson(res, Buffer.from(JSON.stringify(view)));
  });

/**
 * GET /api/orion/runs/[runId]/record: the stored bytes unchanged (FR-20 export, no lease rewrite);
 * `?download=1` adds an attachment filename.
 */
export const createRecordHandler = (deps: HandlerDeps): RouteHandler =>
  readHandler(deps, 'record', (res, req, { head, bytes }) => {
    const download = queryValue(req, 'download') === '1';
    sendJson(
      res,
      bytes,
      download ? { 'Content-Disposition': `attachment; filename="${recordFilename(head.runId)}"` } : {},
    );
  });
