/** @jest-environment node */
import { readdirSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import type { OrionActionName, RunAgentInput } from '../agui/types';
import { ConfigError, readConfig, type AwsConfig, type BffConfig } from './config';
import { createAguiHandler, type HandlerDeps } from './handlers';
import { setLogger, type Logger } from './log';
import { DEFAULT_TIMERS } from './relay';
import { SessionRegistry } from './sessions';
import { signRequest } from './sigv4';
import {
  answer,
  bffError,
  deferred,
  FIXTURE_DIR,
  open,
  parseFrames,
  postTurn,
  readAll,
  readFixture,
  send,
  serveRoute,
  sleep,
  SSE_HEADERS,
  startFake,
  streamChunks,
  TEST_CREDENTIALS,
  TEST_RUNTIME_ARN,
  within,
  type Fake,
  type Listening,
  type Script,
} from './testHarness';

interface Example {
  name: string;
  body: RunAgentInput;
}
const EXAMPLES = (JSON.parse(readFixture('request-examples.json').toString('utf8')) as { examples: Example[] }).examples;
const example = (action: OrionActionName, field?: string): RunAgentInput => {
  const found = EXAMPLES.find(
    ({ body }) =>
      body.forwardedProps.orion.action === action &&
      (field === undefined || (body.forwardedProps.orion as { field?: string }).field === field),
  );
  if (!found) throw new Error(`no ${action} example`);
  return structuredClone(found.body);
};
/** The same turn on another thread or run. */
const retarget = (body: RunAgentInput, ids: Partial<Pick<RunAgentInput, 'threadId' | 'runId'>>): RunAgentInput => ({
  ...structuredClone(body),
  ...ids,
});

const STREAMS = readdirSync(FIXTURE_DIR).filter((name) => name.endsWith('.events.jsonl')).sort();
const J1 = readFixture('j1-complete.events.jsonl');
const J1_FRAMES = J1.toString('utf8').split(/(?<=\n\n)/);

const THREAD = 'eb3893e3ec4b61d471d1cba4abfd912a';
const OTHER_THREAD = '0123456789abcdef0123456789abcdef';
const TRACEPARENT = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';

const minimal = (body: RunAgentInput): Buffer =>
  Buffer.from(
    `data: {"type":"RUN_STARTED","threadId":"${body.threadId}","runId":"${body.runId}"}\n\n` +
      `data: {"type":"RUN_FINISHED","threadId":"${body.threadId}","runId":"${body.runId}",` +
      '"result":{"status":"Recorded","code":null}}\n\n',
  );

/** Writes the first frames, then holds the stream open until the connection closes. */
const hold =
  (bytes: Buffer | string = J1_FRAMES.slice(0, 2).join('')): Script =>
  async (res, recorded) => {
    res.writeHead(200, SSE_HEADERS);
    if (bytes.length) res.write(bytes);
    await recorded.closed;
  };

let fake: Fake;
let route: Listening;
let sessions: SessionRegistry;
let logs: { level: string; event: string; fields?: Record<string, unknown> }[];
let restoreLogger: Logger;

const localConfig = (): BffConfig => ({ mode: 'L', agentUrl: new URL(fake.url), runDir: '/nonexistent' });

const awsConfig = (): AwsConfig => ({
  mode: 'A',
  region: 'us-east-1',
  runtimeArn: TEST_RUNTIME_ARN,
  qualifier: 'DEFAULT',
  runBucket: 'orion-runs-example',
  runPrefix: 'orion/',
  agentCoreEndpoint: new URL(fake.url),
  s3Endpoint: null,
});

const startRoute = async (overrides: Partial<HandlerDeps> = {}) => {
  sessions = new SessionRegistry();
  route = await serveRoute(
    createAguiHandler({
      authenticate: async () => true,
      config: localConfig,
      credentials: async () => TEST_CREDENTIALS,
      sessions,
      timers: { ...DEFAULT_TIMERS, firstByteMs: 1_000, idleMs: 3_000, stopGraceMs: 400, preemptWaitMs: 1_000 },
      now: Date.now,
      ...overrides,
    }),
  );
};

beforeEach(async () => {
  logs = [];
  restoreLogger = setLogger((level, event, fields) => logs.push({ level, event, fields }));
  fake = await startFake();
});

const waitFor = async (check: () => boolean, what: string, ms = 3_000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await sleep(5);
  }
};

afterEach(async () => {
  await route?.close();
  await fake.close();
  // Calls a test left open end with the fake; let them finish before the next test logs.
  await waitFor(() => sessions.size === 0, 'open upstream calls to close');
  setLogger(restoreLogger);
});

describe('POST /api/orion/agui, mode L', () => {
  beforeEach(() => startRoute());

  it.each(STREAMS)('relays %s byte for byte with the contract headers', async (name) => {
    const bytes = readFixture(name);
    fake.enqueue(streamChunks(bytes));
    const raw = await postTurn(route.url, example('ask'));
    expect(raw.status).toBe(200);
    expect(raw.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(raw.headers['cache-control']).toBe('no-cache, no-transform');
    expect(raw.headers['x-accel-buffering']).toBe('no');
    expect(raw.headers['content-encoding']).toBeUndefined();
    expect(raw.body.equals(bytes)).toBe(true);
  });

  it.each(EXAMPLES.map((e) => [e.name, e] as const))(
    'forwards "%s" to /invocations with the session id, unchanged',
    async (_name, { body }) => {
      fake.enqueue(streamChunks(minimal(body)));
      const sent = JSON.stringify(body, null, 1); // not compact: the bytes must still pass through as sent
      const raw = await postTurn(route.url, sent, { traceparent: TRACEPARENT, Cookie: 'access_token=session-cookie' });
      expect(raw.status).toBe(200);
      const [request] = fake.requests;
      expect(request.method).toBe('POST');
      expect(request.url).toBe('/invocations');
      expect(request.body.toString('utf8')).toBe(sent);
      expect(request.headers['content-type']).toBe('application/json');
      expect(request.headers.accept).toBe('text/event-stream');
      expect(request.headers['x-amzn-bedrock-agentcore-runtime-session-id']).toBe(`orion-${body.threadId}`);
      expect(request.headers['x-amzn-bedrock-agentcore-runtime-session-id']).toHaveLength(38);
      expect(request.headers.traceparent).toBe(TRACEPARENT);
      // The browser's session never reaches the agent.
      expect(request.headers.cookie).toBeUndefined();
      expect(request.headers.authorization).toBeUndefined();
    },
  );

  it('drops a malformed traceparent', async () => {
    fake.enqueue(streamChunks(minimal(example('warmup'))));
    await postTurn(route.url, example('warmup'), { traceparent: 'not-a-trace' });
    expect(fake.requests[0].headers.traceparent).toBeUndefined();
  });

  it('appends /invocations to an agent URL given with a path, and to one already ending in it', async () => {
    for (const agentUrl of [`${fake.url}/agent/`, `${fake.url}/invocations`]) {
      await route.close();
      await startRoute({ config: () => readConfig({ ORION_MODE: 'L', ORION_AGENT_URL: agentUrl }) });
      fake.enqueue(streamChunks(minimal(example('warmup'))));
      expect((await postTurn(route.url, example('warmup'))).status).toBe(200);
    }
    expect(fake.requests.map((r) => r.url)).toEqual(['/agent/invocations', '/invocations']);
  });

  it('streams without buffering: each frame reaches the browser before the agent sends the next', async () => {
    const gate = deferred();
    fake.enqueue(async (res) => {
      res.writeHead(200, SSE_HEADERS);
      res.write(J1_FRAMES[0]);
      await gate.promise;
      res.end(J1_FRAMES.slice(1).join(''));
    });
    const { response } = open(`${route.url}/api/orion/agui`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(example('ask')),
    });
    const res = await within(response, 2_000, 'headers before the second frame');
    expect(res.statusCode).toBe(200);
    const first = await within(
      new Promise<Buffer>((resolve) => res.once('data', (chunk: Buffer) => resolve(chunk))),
      2_000,
      'the first frame alone',
    );
    expect(first.toString('utf8')).toBe(J1_FRAMES[0]);
    res.pause();
    gate.resolve();
    res.resume();
    const rest = await readAll(res);
    expect(Buffer.concat([first, rest]).equals(J1)).toBe(true);
  });
});

describe('POST /api/orion/agui errors before the stream', () => {
  beforeEach(() => startRoute());

  it('answers 401 without a session, before reading the turn or calling the agent', async () => {
    await route.close();
    await startRoute({ authenticate: async () => false });
    const raw = await postTurn(route.url, example('ask'));
    expect(raw.status).toBe(401);
    expect(raw.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(bffError(raw)).toEqual({ code: 'UNAUTHENTICATED', message: 'Sign in to use ORION.' });
    expect(fake.requests).toHaveLength(0);
  });

  it('answers 405 for another method', async () => {
    const raw = await send(`${route.url}/api/orion/agui`);
    expect(raw.status).toBe(405);
    expect(raw.headers.allow).toBe('POST');
    expect(bffError(raw).code).toBe('INVALID_INPUT');
  });

  const missing = (field: keyof RunAgentInput) => {
    const body: Partial<RunAgentInput> = example('ask');
    delete body[field];
    return body;
  };

  it.each([
    ['not JSON', '{"threadId":', {}],
    ['not an object', '[]', {}],
    ['invalid UTF-8', Buffer.from([0x7b, 0xff, 0x7d]), {}],
    ['text/plain (a cross-site form post)', JSON.stringify(example('ask')), { 'Content-Type': 'text/plain' }],
    ['a compressed body', JSON.stringify(example('ask')), { 'Content-Encoding': 'gzip' }],
    ['an uppercase threadId', { ...example('ask'), threadId: THREAD.toUpperCase() }, {}],
    ['a short runId', { ...example('ask'), runId: 'abc' }, {}],
    ['a numeric runId', { ...example('ask'), runId: 1 }, {}],
    ...(['threadId', 'runId', 'state', 'messages', 'tools', 'context', 'forwardedProps'] as const).map(
      (field) => [`no ${field}`, missing(field), {}] as const,
    ),
    ['state not an object', { ...example('ask'), state: [] }, {}],
    ['messages not an array', { ...example('ask'), messages: {} }, {}],
    ['no forwardedProps.orion', { ...example('ask'), forwardedProps: {} }, {}],
    ['an unknown action', { ...example('ask'), forwardedProps: { orion: { action: 'delete_run' } } }, {}],
  ])('answers 400 INVALID_INPUT for %s, without calling the agent', async (_what, body, headers) => {
    const raw = await postTurn(route.url, body, headers as Record<string, string>);
    expect(raw.status).toBe(400);
    expect(raw.headers['cache-control']).toBe('no-store');
    expect(bffError(raw).code).toBe('INVALID_INPUT');
    expect(fake.requests).toHaveLength(0);
  });

  it('answers 400 for a body over 8 MiB', async () => {
    const raw = await postTurn(route.url, `{"pad":"${'x'.repeat(8 * 1024 * 1024)}"}`);
    expect(raw.status).toBe(400);
    expect(bffError(raw)).toEqual({ code: 'INVALID_INPUT', message: 'The body is too large.' });
    expect(fake.requests).toHaveLength(0);
  });

  it.each([
    [409, 409, 'SESSION_BUSY'],
    [429, 503, 'UPSTREAM_UNAVAILABLE'],
    [503, 503, 'UPSTREAM_UNAVAILABLE'],
    [500, 502, 'UPSTREAM_ERROR'],
    [400, 502, 'UPSTREAM_ERROR'],
    [403, 502, 'UPSTREAM_ERROR'],
    [424, 502, 'UPSTREAM_ERROR'],
  ])('maps an agent HTTP %i to %i %s', async (upstream, status, code) => {
    fake.enqueue(answer(upstream));
    const raw = await postTurn(route.url, example('ask'));
    expect(raw.status).toBe(status);
    expect(bffError(raw).code).toBe(code);
    expect(raw.headers['content-type']).toBe('application/json; charset=utf-8');
  });

  it('answers 502 when a 2xx is not an event stream, or ends before a byte', async () => {
    fake.enqueue(answer(200, { ok: true }));
    expect(bffError(await postTurn(route.url, example('ask'))).code).toBe('UPSTREAM_ERROR');
    fake.enqueue((res) => {
      res.writeHead(200, SSE_HEADERS);
      res.end();
    });
    const raw = await postTurn(route.url, example('ask'));
    expect(raw.status).toBe(502);
    expect(bffError(raw).code).toBe('UPSTREAM_ERROR');
  });

  it('answers 503 when the agent is unreachable', async () => {
    const port = fake.port;
    await fake.close();
    await route.close();
    await startRoute({ config: () => ({ mode: 'L', agentUrl: new URL(`http://127.0.0.1:${port}`), runDir: '/x' }) });
    const raw = await postTurn(route.url, example('ask'));
    expect(raw.status).toBe(503);
    expect(bffError(raw).code).toBe('UPSTREAM_UNAVAILABLE');
    fake = await startFake();
  });

  it('answers 503 when the deployment is misconfigured', async () => {
    await route.close();
    await startRoute({
      config: () => {
        throw new ConfigError('ORION_MODE must be L, A or H');
      },
    });
    const raw = await postTurn(route.url, example('ask'));
    expect(raw.status).toBe(503);
    expect(bffError(raw).code).toBe('UPSTREAM_UNAVAILABLE');
  });

  it('answers 504 when no byte arrives in time, and aborts the agent call', async () => {
    fake.enqueue(hold(''));
    const started = Date.now();
    const raw = await postTurn(route.url, example('ask'));
    expect(raw.status).toBe(504);
    expect(bffError(raw).code).toBe('UPSTREAM_TIMEOUT');
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(await within(fake.requests[0].closed, 1_000, 'the aborted call')).toBe(true);
    // The session is free again.
    fake.enqueue(streamChunks(minimal(example('ask'))));
    expect((await postTurn(route.url, example('ask'))).status).toBe(200);
  });

  it('answers 504 when the agent sends headers but no byte', async () => {
    fake.enqueue(async (res, recorded) => {
      res.writeHead(200, SSE_HEADERS);
      res.flushHeaders();
      await recorded.closed;
    });
    const raw = await postTurn(route.url, example('ask'));
    expect(raw.status).toBe(504);
    expect(bffError(raw).code).toBe('UPSTREAM_TIMEOUT');
  });
});

describe('one call per session', () => {
  beforeEach(() => startRoute());

  it.each([
    ['ask'],
    ['warmup'],
    ['viz_report'],
    ['retry_step'],
    ['clarify_answer'],
    ['consent'],
  ] as const)('refuses a %s while the thread has an open call with 409 SESSION_BUSY', async (action) => {
    fake.enqueue(hold());
    const first = open(`${route.url}/api/orion/agui`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(example('ask')),
    });
    await first.response;
    await fake.request(0);
    const second = await postTurn(route.url, retarget(example(action), { threadId: example('ask').threadId }));
    expect(second.status).toBe(409);
    expect(bffError(second).code).toBe('SESSION_BUSY');
    expect(fake.requests).toHaveLength(1);
    // Another thread is not blocked.
    fake.enqueue(streamChunks(minimal(example('warmup'))));
    const other = await postTurn(route.url, retarget(example('warmup'), { threadId: OTHER_THREAD }));
    expect(other.status).toBe(200);
    first.req.destroy();
  });
});

describe('Stop, edit and confirm abort the open call', () => {
  beforeEach(() => startRoute());

  const openTurn = (body: RunAgentInput) =>
    open(`${route.url}/api/orion/agui`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it.each([['cancel'], ['edit_plan']] as const)(
    '%s aborts the streaming call, then sends the new turn; the old stream just ends',
    async (action) => {
      const threadId = example(action).threadId;
      const ask = retarget(example('ask'), { threadId });
      fake.enqueue(hold());
      const first = openTurn(ask);
      const firstRes = await first.response;
      const firstBody = readAll(firstRes);
      await fake.request(0);
      const reply = action === 'cancel' ? readFixture('j1-stop.events.jsonl') : minimal(example(action));
      fake.enqueue(streamChunks(reply));
      const second = await postTurn(route.url, example(action));
      expect(second.status).toBe(200);
      expect(second.body.equals(reply)).toBe(true);
      expect(await fake.requests[0].closed).toBe(true);
      // The BFF closed the old call before it sent the new turn.
      const events = logs.map((entry) => `${entry.event}:${String(entry.fields?.action)}`);
      expect(events.indexOf('turn_ended:ask')).toBeGreaterThan(-1);
      expect(events.indexOf('turn_ended:ask')).toBeLessThan(events.indexOf(`turn_sent:${action}`));
      expect(logs.find((entry) => entry.event === 'turn_ended')?.fields).toMatchObject({
        threadId,
        aborted: true,
        terminal: false,
      });
      // No frame is invented for the aborted call: the browser gets what the agent sent, then the end.
      expect((await firstBody).toString('utf8')).toBe(J1_FRAMES.slice(0, 2).join(''));
      expect(fake.requests[1].body.toString('utf8')).toBe(JSON.stringify(example(action)));
    },
  );

  it('confirm aborts an open call before its first byte, then sends; the aborted turn gets 409 (E19)', async () => {
    const confirm = example('confirm');
    const ask = retarget(example('ask'), { threadId: confirm.threadId });
    fake.enqueue(hold(''));
    const first = postTurn(route.url, ask);
    await fake.request(0);
    fake.enqueue(streamChunks(minimal(confirm)));
    const second = await postTurn(route.url, confirm);
    expect(second.status).toBe(200);
    expect(await fake.requests[0].closed).toBe(true);
    const aborted = await first;
    expect(aborted.status).toBe(409);
    expect(bffError(aborted).code).toBe('SESSION_BUSY');
    expect(fake.requests.map((r) => JSON.parse(r.body.toString('utf8')).forwardedProps.orion.action)).toEqual([
      'ask',
      'confirm',
    ]);
  });

  it('a resent confirm reaches the agent again instead of SESSION_BUSY', async () => {
    const confirm = example('confirm');
    fake.enqueue(hold());
    const first = openTurn(confirm);
    await first.response;
    await fake.request(0);
    fake.enqueue(streamChunks(readFixture('j3-after-confirm.events.jsonl')));
    const resent = await postTurn(route.url, confirm);
    expect(resent.status).toBe(200);
    expect(resent.body.equals(readFixture('j3-after-confirm.events.jsonl'))).toBe(true);
    expect(fake.requests).toHaveLength(2);
  });

  it('a Stop waiting for an aborted call that a newer Stop replaces answers 409 and is never sent', async () => {
    await route.close();
    await startRoute({
      timers: { ...DEFAULT_TIMERS, firstByteMs: 1_000, idleMs: 3_000, stopGraceMs: 400, preemptWaitMs: 300 },
    });
    const cancel = example('cancel');
    // An open call whose connection never closes, so the next turn waits out preemptWaitMs.
    sessions.claim(cancel.threadId, 'cc'.repeat(16), 'ask');
    fake.enqueue(streamChunks(minimal(cancel)));
    const one = postTurn(route.url, cancel);
    await sleep(50);
    const two = postTurn(route.url, cancel);
    const [a, b] = await Promise.all([one, two]);
    expect(a.status).toBe(409);
    expect(bffError(a).code).toBe('SESSION_BUSY');
    expect(b.status).toBe(200);
    expect(fake.requests).toHaveLength(1);
  });
});

describe('no disconnect forwarding', () => {
  beforeEach(() => startRoute());

  it('keeps reading the agent to its end after the browser leaves, and frees the session only then', async () => {
    const ask = example('ask');
    const gate = deferred();
    const done = deferred();
    fake.enqueue(async (res) => {
      res.writeHead(200, SSE_HEADERS);
      res.write(J1_FRAMES[0]);
      await gate.promise;
      for (const frame of J1_FRAMES.slice(1)) {
        res.write(frame);
        await sleep(1);
      }
      res.end();
      done.resolve();
    });
    const first = open(`${route.url}/api/orion/agui`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ask),
    });
    const res = await first.response;
    await new Promise((resolve) => res.once('data', resolve));
    first.req.destroy();
    res.destroy();
    await sleep(50);
    // Still busy: the agent's call is open.
    const busy = await postTurn(route.url, retarget(ask, { runId: 'aa'.repeat(16) }));
    expect(busy.status).toBe(409);
    gate.resolve();
    await within(done.promise, 2_000, 'the agent finishing');
    expect(await fake.requests[0].closed).toBe(false);
    await waitFor(() => sessions.size === 0, 'the session to free');
    fake.enqueue(streamChunks(minimal(ask)));
    expect((await postTurn(route.url, retarget(ask, { runId: 'bb'.repeat(16) }))).status).toBe(200);
    const ended = logs.find((entry) => entry.event === 'turn_ended');
    expect(ended?.fields).toMatchObject({ clientGone: true, terminal: true, bytes: J1.length });
  });
});

describe('after the stream started', () => {
  beforeEach(() => startRoute());

  it('an agent failure only ends the response: the bytes so far, no invented frame', async () => {
    const prefix = J1_FRAMES.slice(0, 3).join('') + J1_FRAMES[3].slice(0, 40);
    fake.enqueue((res) => {
      res.writeHead(200, SSE_HEADERS);
      res.write(prefix, () => setTimeout(() => res.destroy(), 20));
    });
    const raw = await postTurn(route.url, example('ask'));
    expect(raw.status).toBe(200);
    expect(raw.body.toString('utf8')).toBe(prefix);
    expect(parseFrames(Buffer.from(J1_FRAMES.slice(0, 3).join(''))).map((f) => f.type)).not.toContain('RUN_FINISHED');
  });

  it('holds the agent back while the browser reads slowly, without tripping the idle limit', async () => {
    await route.close();
    await startRoute({
      timers: { ...DEFAULT_TIMERS, firstByteMs: 1_000, idleMs: 300, stopGraceMs: 400, preemptWaitMs: 300 },
    });
    // 16 MiB of heartbeat frames (more than the loopback socket buffers hold), written as fast as accepted.
    const frame = Buffer.from('data: {"type":"CUSTOM","name":"orion.heartbeat","value":{"ts":"2026-11-05T12:00:00.000Z"}}\n\n');
    const big = Buffer.concat(Array.from({ length: Math.ceil((16 * 1024 * 1024) / frame.length) }, () => frame));
    fake.enqueue(streamChunks(big, { sizes: [65_536], gapMs: 0 }));
    const { response } = open(`${route.url}/api/orion/agui`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(example('ask')),
    });
    const res = await response;
    const chunks: Buffer[] = [];
    res.on('data', (chunk: Buffer) => chunks.push(chunk));
    res.pause();
    await sleep(700); // over twice the idle limit with the browser not reading
    const ended = new Promise((resolve) => res.on('end', resolve));
    res.resume();
    await within(ended, 5_000, 'the slow read to finish');
    expect(Buffer.concat(chunks).equals(big)).toBe(true);
    expect(logs.some((entry) => entry.event === 'upstream_idle')).toBe(false);
  });

  it('ends the response when the agent goes silent past the idle limit', async () => {
    await route.close();
    await startRoute({
      timers: { ...DEFAULT_TIMERS, firstByteMs: 1_000, idleMs: 200, stopGraceMs: 400, preemptWaitMs: 300 },
    });
    fake.enqueue(hold());
    const raw = await within(postTurn(route.url, example('ask')), 2_000, 'the idle end');
    expect(raw.status).toBe(200);
    expect(raw.body.toString('utf8')).toBe(J1_FRAMES.slice(0, 2).join(''));
    expect(await fake.requests[0].closed).toBe(true);
    expect(logs.some((entry) => entry.event === 'upstream_idle')).toBe(true);
  });
});

describe('modes A and H: InvokeAgentRuntime and StopRuntimeSession', () => {
  const ARN_PATH = `/runtimes/${encodeURIComponent(TEST_RUNTIME_ARN)}`;

  beforeEach(() => startRoute({ config: awsConfig }));

  /** Recomputes the signature the request carries from what the endpoint received. */
  const verifySignature = (request: (typeof fake.requests)[number]) => {
    const headers = Object.fromEntries(
      Object.entries(request.headers)
        .filter(([name]) => !['authorization', 'connection', 'content-length', 'host'].includes(name))
        .map(([name, value]) => [name, String(value)]),
    );
    const date = String(request.headers['x-amz-date']);
    const now = new Date(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${date.slice(9, 11)}:${date.slice(11, 13)}:${date.slice(13, 15)}Z`);
    const expected = signRequest({
      method: request.method,
      url: new URL(`http://${request.headers.host}${request.url}`),
      headers,
      body: request.body,
      service: 'bedrock-agentcore',
      region: 'us-east-1',
      credentials: TEST_CREDENTIALS,
      now,
    });
    expect(request.headers.authorization).toBe(expected.headers.Authorization);
  };

  it('signs InvokeAgentRuntime and relays its stream unchanged', async () => {
    const body = example('ask');
    fake.enqueue(streamChunks(J1));
    const raw = await postTurn(route.url, body, { traceparent: TRACEPARENT });
    expect(raw.status).toBe(200);
    expect(raw.body.equals(J1)).toBe(true);
    const [request] = fake.requests;
    expect(request.method).toBe('POST');
    expect(request.url).toBe(`${ARN_PATH}/invocations?qualifier=DEFAULT`);
    expect(request.headers['x-amzn-bedrock-agentcore-runtime-session-id']).toBe(`orion-${body.threadId}`);
    expect(request.headers['content-type']).toBe('application/json');
    expect(request.headers.accept).toBe('text/event-stream');
    expect(request.headers.traceparent).toBe(TRACEPARENT);
    expect(request.headers['x-amz-security-token']).toBe(TEST_CREDENTIALS.sessionToken);
    expect(String(request.headers.authorization)).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/bedrock-agentcore\/aws4_request, SignedHeaders=accept;content-type;host;x-amz-date;x-amz-security-token;x-amzn-bedrock-agentcore-runtime-session-id, Signature=[0-9a-f]{64}$/,
    );
    expect(request.body.toString('utf8')).toBe(JSON.stringify(body));
    verifySignature(request);
  });

  it('maps a busy session (409 RetryableConflictException) to SESSION_BUSY', async () => {
    fake.enqueue(answer(409, { message: 'busy' }, { 'x-amzn-errortype': 'RetryableConflictException:' }));
    const raw = await postTurn(route.url, example('ask'));
    expect(raw.status).toBe(409);
    expect(bffError(raw).code).toBe('SESSION_BUSY');
    expect(logs.find((entry) => entry.event === 'upstream_status')?.fields).toMatchObject({
      status: 409,
      errorType: 'RetryableConflictException',
    });
  });

  it('answers 503 when no AWS credentials can be found', async () => {
    await route.close();
    await startRoute({
      config: awsConfig,
      credentials: async () => {
        throw new Error('No AWS credentials');
      },
    });
    const raw = await postTurn(route.url, example('ask'));
    expect(raw.status).toBe(503);
    expect(bffError(raw).code).toBe('UPSTREAM_UNAVAILABLE');
    expect(fake.requests).toHaveLength(0);
  });

  it('a cancel whose Cancelled snapshot arrives in time never calls StopRuntimeSession', async () => {
    fake.enqueue(streamChunks(readFixture('j1-stop.events.jsonl')));
    const raw = await postTurn(route.url, example('cancel'));
    expect(raw.status).toBe(200);
    await sleep(600);
    expect(fake.requests.map((r) => r.url)).toEqual([`${ARN_PATH}/invocations?qualifier=DEFAULT`]);
  });

  it('calls StopRuntimeSession when no Cancelled snapshot arrives within the grace (C-18)', async () => {
    const cancel = example('cancel');
    // Stopping, then nothing: the controller is stuck.
    const stopping = readFixture('j1-stop.events.jsonl').toString('utf8').split(/(?<=\n\n)/).slice(0, 2).join('');
    fake.enqueue(hold(stopping));
    fake.enqueue(answer(200, { runtimeSessionId: `orion-${cancel.threadId}` }));
    const turn = open(`${route.url}/api/orion/agui`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cancel),
    });
    const res = await turn.response;
    const stop = await within(fake.request(1), 2_000, 'StopRuntimeSession');
    expect(stop.method).toBe('POST');
    expect(stop.url).toBe(`${ARN_PATH}/stopruntimesession?qualifier=DEFAULT`);
    expect(stop.headers['x-amzn-bedrock-agentcore-runtime-session-id']).toBe(`orion-${cancel.threadId}`);
    expect(stop.headers['content-type']).toBe('application/json');
    const token = (JSON.parse(stop.body.toString('utf8')) as { clientToken: string }).clientToken;
    expect(token).toMatch(/^[0-9a-f-]{36}$/);
    verifySignature(stop);
    await waitFor(() => logs.some((entry) => entry.event === 'stop_session'), 'the stop log');
    expect(logs.find((entry) => entry.event === 'stop_session')?.fields).toMatchObject({ ok: true, status: 200 });
    turn.req.destroy();
    res.destroy();
  });

  it('calls StopRuntimeSession when the cancel itself is refused as busy', async () => {
    fake.enqueue(answer(409, { message: 'busy' }, { 'x-amzn-errortype': 'RetryableConflictException:' }));
    fake.enqueue(answer(200, {}));
    const raw = await postTurn(route.url, example('cancel'));
    expect(raw.status).toBe(409);
    const stop = await within(fake.request(1), 2_000, 'StopRuntimeSession');
    expect(stop.url).toBe(`${ARN_PATH}/stopruntimesession?qualifier=DEFAULT`);
  });

  it('an edit aborts the open call but never stops the session', async () => {
    const edit = example('edit_plan', 'method');
    fake.enqueue(hold());
    const first = open(`${route.url}/api/orion/agui`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(retarget(example('ask'), { threadId: edit.threadId })),
    });
    await first.response;
    await fake.request(0);
    fake.enqueue(hold(minimal(edit).toString('utf8').split('\n\n')[0] + '\n\n'));
    const second = open(`${route.url}/api/orion/agui`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(edit),
    });
    const res: IncomingMessage = await second.response;
    expect(res.statusCode).toBe(200);
    expect(await fake.requests[0].closed).toBe(true);
    await sleep(600);
    expect(fake.requests.filter((r) => r.url.includes('stopruntimesession'))).toHaveLength(0);
    second.req.destroy();
    first.req.destroy();
  });
});

describe('mode L never calls StopRuntimeSession', () => {
  beforeEach(() => startRoute());

  it('leaves a stuck cancel to the lease', async () => {
    const stopping = readFixture('j1-stop.events.jsonl').toString('utf8').split(/(?<=\n\n)/).slice(0, 2).join('');
    fake.enqueue(hold(stopping));
    const turn = open(`${route.url}/api/orion/agui`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(example('cancel')),
    });
    await turn.response;
    await sleep(600);
    expect(fake.requests).toHaveLength(1);
    turn.req.destroy();
  });
});
