// Test-only helpers for the BFF tests: real HTTP servers on 127.0.0.1 (the route under test, a
// fake agent, fake AWS endpoints) and a raw HTTP client. Nothing in the app imports this module.

import { readFileSync } from 'node:fs';
import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { RouteHandler, RouteRequest } from './handlers';
import type { AwsCredentials } from './sigv4';

export const FIXTURE_DIR = path.join(__dirname, '..', 'agui', '__fixtures__');
export const readFixture = (name: string): Buffer => readFileSync(path.join(FIXTURE_DIR, name));

/** Splits SSE bytes after each blank line, keeping the terminators. */
export const sseFrames = (bytes: Buffer): Buffer[] => {
  const frames: Buffer[] = [];
  let start = 0;
  for (let end = bytes.indexOf('\n\n'); end !== -1; end = bytes.indexOf('\n\n', start)) {
    frames.push(bytes.subarray(start, end + 2));
    start = end + 2;
  }
  if (start < bytes.length) frames.push(bytes.subarray(start));
  return frames;
};

export const parseFrames = (bytes: Buffer): Record<string, unknown>[] =>
  sseFrames(bytes).map((frame) => JSON.parse(frame.toString('utf8').replace(/^data: /, '')) as Record<string, unknown>);

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

export const deferred = <T = void>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

/** Fails fast instead of hanging a test on a promise that never settles. */
export const within = <T>(promise: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error(`timed out: ${what}`)), ms)),
  ]);

export interface Listening {
  url: string;
  port: number;
  close(): Promise<void>;
}

export const listen = async (
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
): Promise<Listening> => {
  const server = http.createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};

/**
 * Serves a route handler the way Next.js would call it: `req.query` holds the search parameters
 * (repeated ones as arrays) and the dynamic `runId` segment (`dynamic`'s group 1).
 */
export const serveRoute = (handler: RouteHandler, dynamic?: RegExp): Promise<Listening> =>
  listen(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://test.invalid');
    const query: Record<string, string | string[]> = {};
    for (const key of new Set(url.searchParams.keys())) {
      const all = url.searchParams.getAll(key);
      query[key] = all.length > 1 ? all : all[0];
    }
    const match = dynamic?.exec(url.pathname);
    if (match) query.runId = match[1];
    const routeReq = req as RouteRequest;
    routeReq.query = query;
    await handler(routeReq, res);
  });

/** The `[runId]` segment of the two run routes, as group 1. */
export const RUN_ROUTE = /^\/api\/orion\/runs\/([^/]+)\/(?:view|record)$/;

// ------------------------------------------------------------------- the fake upstream

export interface Recorded {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
  /** Resolves when the connection closes; true when the client closed it before the response ended. */
  closed: Promise<boolean>;
}

export type Script = (res: ServerResponse, recorded: Recorded) => void | Promise<void>;

export interface Fake extends Listening {
  requests: Recorded[];
  /** The next request's behaviour; requests with no script queued get 500. */
  enqueue(script: Script): void;
  /** Resolves with the n-th request (0-based) once it arrived. */
  request(n: number): Promise<Recorded>;
}

export const startFake = async (): Promise<Fake> => {
  const requests: Recorded[] = [];
  const scripts: Script[] = [];
  const waiters = new Map<number, Deferred<Recorded>>();
  const waiter = (n: number): Deferred<Recorded> => {
    let entry = waiters.get(n);
    if (!entry) {
      entry = deferred<Recorded>();
      waiters.set(n, entry);
    }
    return entry;
  };
  const server = await listen(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const closed = deferred<boolean>();
    res.on('close', () => closed.resolve(!res.writableFinished));
    const recorded: Recorded = {
      method: req.method ?? '',
      url: req.url ?? '',
      headers: req.headers,
      body: Buffer.concat(chunks),
      closed: closed.promise,
    };
    const n = requests.push(recorded) - 1;
    waiter(n).resolve(recorded);
    const script = scripts.shift();
    if (!script) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end('{"message":"no script"}');
      return;
    }
    try {
      await script(res, recorded);
    } catch {
      res.destroy();
    }
  });
  return {
    ...server,
    requests,
    enqueue: (script) => {
      scripts.push(script);
    },
    request: (n) => waiter(n).promise,
  };
};

export const SSE_HEADERS = { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' };

/** Writes `bytes` in uneven chunks (cutting frames and UTF-8 sequences), then ends. */
export const streamChunks =
  (bytes: Buffer, { sizes = [1, 7, 4096, 13, 977], gapMs = 1 }: { sizes?: number[]; gapMs?: number } = {}): Script =>
  async (res) => {
    res.writeHead(200, SSE_HEADERS);
    let offset = 0;
    for (let i = 0; offset < bytes.length; i++) {
      const size = sizes[i % sizes.length];
      res.write(bytes.subarray(offset, offset + size));
      offset += size;
      if (gapMs) await sleep(gapMs);
    }
    res.end();
  };

/** Answers with a status and a JSON body, as AgentCore does for errors. */
export const answer =
  (status: number, body: unknown = { message: 'error' }, headers: Record<string, string> = {}): Script =>
  (res) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };

// ------------------------------------------------------------------- the client side

export interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

export interface SendOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: Buffer | string;
}

/** Opens a request; resolves with the response once its headers arrive. */
export const open = (url: string, { method = 'GET', headers = {}, body }: SendOptions = {}) => {
  const req = http.request(url, { method, headers, agent: false });
  const response = new Promise<IncomingMessage>((resolve, reject) => {
    req.on('response', resolve);
    req.on('error', reject);
  });
  req.end(body);
  return { req, response };
};

export const readAll = async (response: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of response) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};

export const send = async (url: string, options: SendOptions = {}): Promise<RawResponse> => {
  const response = await open(url, options).response;
  return { status: response.statusCode ?? 0, headers: response.headers, body: await readAll(response) };
};

export const postTurn = (base: string, body: unknown, headers: Record<string, string> = {}): Promise<RawResponse> =>
  send(`${base}/api/orion/agui`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...headers },
    body: typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body),
  });

export const bffError = (raw: RawResponse): { code: string; message: string } =>
  (JSON.parse(raw.body.toString('utf8')) as { error: { code: string; message: string } }).error;

// ------------------------------------------------------------------- shared values

/** AWS's documentation example keys (not real credentials). */
export const TEST_CREDENTIALS: AwsCredentials = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  sessionToken: 'FAKE-SESSION-TOKEN-FOR-TESTS',
};

export const TEST_RUNTIME_ARN = 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/orion_agent-AbCdEf1234';
