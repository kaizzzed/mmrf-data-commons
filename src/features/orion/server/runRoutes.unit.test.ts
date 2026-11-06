/** @jest-environment node */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { RunRecord, RunView } from '../agui/types';
import type { AwsConfig, BffConfig } from './config';
import { createRecordHandler, createViewHandler, type HandlerDeps, type RouteHandler } from './handlers';
import { INTERRUPTED_SUMMARY } from './leaseRule';
import { setLogger, type Logger } from './log';
import { DEFAULT_TIMERS } from './relay';
import { SessionRegistry } from './sessions';
import { signRequest } from './sigv4';
import {
  answer,
  bffError,
  parseFrames,
  readFixture,
  RUN_ROUTE,
  send,
  serveRoute,
  startFake,
  TEST_CREDENTIALS,
  TEST_RUNTIME_ARN,
  type Fake,
  type Listening,
} from './testHarness';

const J1_BYTES = readFixture('run-record.j1-complete.json');
const J1: RunRecord = JSON.parse(J1_BYTES.toString('utf8')) as RunRecord;
const RETRY_BYTES = readFixture('run-record.j1-retry.json');
const RETRY: RunRecord = JSON.parse(RETRY_BYTES.toString('utf8')) as RunRecord;
const OTHER = '0123456789abcdef0123456789abcdef';

const snapshot = (fixture: string, revision: number): RunView =>
  parseFrames(readFixture(fixture))
    .filter((frame) => frame.type === 'STATE_SNAPSHOT')
    .map((frame) => frame.snapshot as RunView)
    .find((view) => view.revision === revision) as RunView;

/** J1 as stored at s4 (revision 6), its controller gone: the lease lapsed at the given time. */
const executingRecord = (expiresAt: string | null): RunRecord => {
  const view = snapshot('j1-complete.events.jsonl', 6);
  return {
    ...J1,
    status: 'Executing',
    revision: 6,
    updatedAt: view.updatedAt,
    lease: expiresAt === null ? null : { owner: 'agent-1', renewedAt: view.updatedAt, expiresAt },
    steps: view.steps,
    runView: view,
  };
};

let logs: string[];
let restore: Logger;
let runDir: string;

beforeEach(() => {
  logs = [];
  restore = setLogger((_level, event) => logs.push(event));
  runDir = mkdtempSync(path.join(tmpdir(), 'orion-bff-'));
  mkdirSync(path.join(runDir, 'runs'));
});

afterEach(() => {
  setLogger(restore);
  rmSync(runDir, { recursive: true, force: true });
});

const store = (record: RunRecord | string | Buffer, runId = J1.runId) =>
  writeFileSync(
    path.join(runDir, 'runs', `${runId}.json`),
    typeof record === 'string' || Buffer.isBuffer(record) ? record : JSON.stringify(record, null, 1),
  );

const deps = (overrides: Partial<HandlerDeps> = {}): HandlerDeps => ({
  authenticate: async () => true,
  config: (): BffConfig => ({ mode: 'L', agentUrl: new URL('http://orion-agent:8080'), runDir }),
  credentials: async () => TEST_CREDENTIALS,
  sessions: new SessionRegistry(),
  timers: DEFAULT_TIMERS,
  now: Date.now,
  ...overrides,
});

const servers: Listening[] = [];
const serve = async (handler: RouteHandler): Promise<string> => {
  const server = await serveRoute(handler, RUN_ROUTE);
  servers.push(server);
  return server.url;
};
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

const viewPath = (runId: string, query = '') => `/api/orion/runs/${runId}/view${query}`;
const recordPath = (runId: string, query = '') => `/api/orion/runs/${runId}/record${query}`;

describe('GET /api/orion/runs/[runId]/view, mode L', () => {
  it('serves the record runView untouched for a run at rest', async () => {
    store(J1_BYTES);
    const base = await serve(createViewHandler(deps()));
    const raw = await send(`${base}${viewPath(J1.runId)}`);
    expect(raw.status).toBe(200);
    expect(raw.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(raw.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(raw.body.toString('utf8'))).toEqual(J1.runView);
  });

  it('checks the thread when the query names one', async () => {
    store(J1_BYTES);
    const base = await serve(createViewHandler(deps()));
    expect((await send(`${base}${viewPath(J1.runId, `?threadId=${J1.threadId}`)}`)).status).toBe(200);
    const other = await send(`${base}${viewPath(J1.runId, `?threadId=${OTHER}`)}`);
    expect(other.status).toBe(404);
    expect(bffError(other).code).toBe('RUN_NOT_FOUND');
  });

  it('applies the expired-lease rule: Interrupted as of the lease expiry', async () => {
    store(executingRecord('2026-11-04T15:03:04.200Z'));
    const base = await serve(createViewHandler(deps()));
    const view = JSON.parse((await send(`${base}${viewPath(J1.runId)}`)).body.toString('utf8')) as RunView;
    // interrupted.events.jsonl shows the same run (other ids) as the agent records it.
    const expected = parseFrames(readFixture('interrupted.events.jsonl'))[1].snapshot as RunView;
    expect(view).toEqual({ ...expected, threadId: J1.threadId, runId: J1.runId });
    expect(view.steps.find((step) => step.id === 's5')?.outputSummary).toBe(INTERRUPTED_SUMMARY);
  });

  it('serves a live lease unchanged', async () => {
    const record = executingRecord(new Date(Date.now() + 120_000).toISOString());
    store(record);
    const base = await serve(createViewHandler(deps()));
    const view = JSON.parse((await send(`${base}${viewPath(J1.runId)}`)).body.toString('utf8')) as RunView;
    expect(view).toEqual(record.runView);
  });

  it('ends a lapsed Stopping run Cancelled', async () => {
    const stopping = parseFrames(readFixture('j1-stop.events.jsonl'))[1].snapshot as RunView;
    store(
      {
        ...J1,
        threadId: stopping.threadId,
        runId: stopping.runId,
        status: 'Stopping',
        revision: stopping.revision,
        lease: { owner: 'agent-1', renewedAt: stopping.updatedAt, expiresAt: '2026-11-04T15:00:39.000Z' },
        runView: stopping,
      },
      stopping.runId,
    );
    const base = await serve(createViewHandler(deps()));
    const view = JSON.parse((await send(`${base}${viewPath(stopping.runId)}`)).body.toString('utf8')) as RunView;
    expect(view.status).toBe('Cancelled');
    expect(view.code).toBeNull();
    expect(view.revision).toBe(stopping.revision + 1);
    expect(view.updatedAt).toBe('2026-11-04T15:00:39.000Z');
  });

  it('serves a view over 32 KB untrimmed', async () => {
    const big: RunView = {
      ...(J1.runView as RunView),
      steps: (J1.runView as RunView).steps.map((step) => ({ ...step, inputSummary: 'x'.repeat(10_000) })),
    };
    store({ ...J1, runView: big });
    const base = await serve(createViewHandler(deps()));
    const raw = await send(`${base}${viewPath(J1.runId)}`);
    expect(raw.body.length).toBeGreaterThan(32 * 1024);
    expect(JSON.parse(raw.body.toString('utf8'))).toEqual(big);
  });

  it('keeps the environment as recorded (mode H fingerprint)', async () => {
    const view = { ...(J1.runView as RunView), environment: { mode: 'H' as const, fingerprintSha256: 'f'.repeat(64) } };
    store({ ...J1, environment: { ...J1.environment, mode: 'H' }, runView: view });
    const base = await serve(createViewHandler(deps()));
    const served = JSON.parse((await send(`${base}${viewPath(J1.runId)}`)).body.toString('utf8')) as RunView;
    expect(served.environment).toEqual({ mode: 'H', fingerprintSha256: 'f'.repeat(64) });
  });

  it.each([
    ['a missing record', null],
    ['a record without a runView', { ...J1, runView: null }],
  ])('answers 404 RUN_NOT_FOUND for %s', async (_what, record) => {
    if (record) store(record as RunRecord);
    const base = await serve(createViewHandler(deps()));
    const raw = await send(`${base}${viewPath(J1.runId)}`);
    expect(raw.status).toBe(404);
    expect(bffError(raw).code).toBe('RUN_NOT_FOUND');
  });

  it.each([
    ['an uppercase runId', viewPath(J1.runId.toUpperCase())],
    ['a short runId', viewPath('abc')],
    ['a traversal runId', viewPath('..%2F..%2Fetc%2Fpasswd')],
    ['a malformed threadId', viewPath(J1.runId, '?threadId=xyz')],
    ['two threadIds', viewPath(J1.runId, `?threadId=${J1.threadId}&threadId=${J1.threadId}`)],
  ])('answers 400 INVALID_INPUT for %s', async (_what, url) => {
    store(J1_BYTES);
    const base = await serve(createViewHandler(deps()));
    const raw = await send(`${base}${url}`);
    expect(raw.status).toBe(400);
    expect(bffError(raw).code).toBe('INVALID_INPUT');
  });

  it.each([
    ['not JSON', '{"schema":'],
    ['another schema', JSON.stringify({ ...J1, schema: 'orion.run-view/v1' })],
    ['another runId', JSON.stringify({ ...J1, runId: OTHER })],
    ['a runView of another run', JSON.stringify({ ...J1, runView: { ...J1.runView, runId: OTHER } })],
    ['an unknown status', JSON.stringify({ ...J1, status: 'Done' })],
  ])('answers 502 UPSTREAM_ERROR for a stored record with %s', async (_what, text) => {
    store(text);
    const base = await serve(createViewHandler(deps()));
    const raw = await send(`${base}${viewPath(J1.runId)}`);
    expect(raw.status).toBe(502);
    expect(bffError(raw).code).toBe('UPSTREAM_ERROR');
    expect(logs).toContain('record_malformed');
  });

  it('answers 401 without a session, before reading the store', async () => {
    store(J1_BYTES);
    const read = jest.fn();
    const base = await serve(
      createViewHandler(deps({ authenticate: async () => false, storeFor: () => ({ read }) })),
    );
    const raw = await send(`${base}${viewPath(J1.runId)}`);
    expect(raw.status).toBe(401);
    expect(bffError(raw).code).toBe('UNAUTHENTICATED');
    expect(read).not.toHaveBeenCalled();
  });

  it('answers 405 for another method', async () => {
    const base = await serve(createViewHandler(deps()));
    const raw = await send(`${base}${viewPath(J1.runId)}`, { method: 'POST' });
    expect(raw.status).toBe(405);
    expect(raw.headers.allow).toBe('GET');
  });

  it('answers 503 when the volume cannot be read (a symlink loop)', async () => {
    symlinkSync(`${J1.runId}.json`, path.join(runDir, 'runs', `${J1.runId}.json`));
    const base = await serve(createViewHandler(deps()));
    const raw = await send(`${base}${viewPath(J1.runId)}`);
    expect(raw.status).toBe(503);
    expect(bffError(raw).code).toBe('UPSTREAM_UNAVAILABLE');
    expect(logs).toContain('record_read_failed');
  });

  it('answers 404 when the record path is a directory', async () => {
    mkdirSync(path.join(runDir, 'runs', `${J1.runId}.json`));
    const base = await serve(createViewHandler(deps()));
    expect((await send(`${base}${viewPath(J1.runId)}`)).status).toBe(404);
  });
});

describe('GET /api/orion/runs/[runId]/record, mode L', () => {
  it('serves the stored bytes unchanged, with no lease rewrite', async () => {
    const lapsed = Buffer.from(JSON.stringify(executingRecord('2026-11-04T15:03:04.200Z'), null, 2));
    store(lapsed);
    const base = await serve(createRecordHandler(deps()));
    const raw = await send(`${base}${recordPath(J1.runId)}`);
    expect(raw.status).toBe(200);
    expect(raw.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(raw.headers['cache-control']).toBe('no-store');
    expect(raw.headers['content-disposition']).toBeUndefined();
    expect(raw.body.equals(lapsed)).toBe(true);
  });

  it.each([
    ['run-record.j1-complete.json', J1_BYTES, J1],
    ['run-record.j1-retry.json', RETRY_BYTES, RETRY],
  ])('exports %s as an attachment with ?download=1', async (_name, bytes, record) => {
    store(bytes, record.runId);
    const base = await serve(createRecordHandler(deps()));
    const raw = await send(`${base}${recordPath(record.runId, `?threadId=${record.threadId}&download=1`)}`);
    expect(raw.status).toBe(200);
    expect(raw.headers['content-disposition']).toBe(`attachment; filename="orion-run-${record.runId}.json"`);
    expect(raw.body.equals(bytes)).toBe(true);
  });

  it('serves a record that has no runView yet', async () => {
    const bytes = Buffer.from(JSON.stringify({ ...J1, runView: null }));
    store(bytes);
    const base = await serve(createRecordHandler(deps()));
    expect((await send(`${base}${recordPath(J1.runId)}`)).body.equals(bytes)).toBe(true);
  });

  it('answers 404 for another thread or a missing record, and 400 for a bad id', async () => {
    store(J1_BYTES);
    const base = await serve(createRecordHandler(deps()));
    expect((await send(`${base}${recordPath(J1.runId, `?threadId=${OTHER}`)}`)).status).toBe(404);
    expect((await send(`${base}${recordPath(OTHER)}`)).status).toBe(404);
    expect((await send(`${base}${recordPath('ZZ')}`)).status).toBe(400);
  });

  it('answers 401 without a session', async () => {
    store(J1_BYTES);
    const base = await serve(createRecordHandler(deps({ authenticate: async () => false })));
    const raw = await send(`${base}${recordPath(J1.runId)}`);
    expect(raw.status).toBe(401);
    expect(raw.body.includes(Buffer.from(J1.runId))).toBe(false);
  });
});

describe('the run routes in modes A and H read S3', () => {
  let fake: Fake;
  beforeEach(async () => {
    fake = await startFake();
  });
  afterEach(() => fake.close());

  const awsDeps = (mode: 'A' | 'H' = 'A', prefix = 'orion/'): HandlerDeps =>
    deps({
      config: (): AwsConfig => ({
        mode,
        region: 'us-east-1',
        runtimeArn: TEST_RUNTIME_ARN,
        qualifier: 'DEFAULT',
        runBucket: 'orion-runs-example',
        runPrefix: prefix,
        agentCoreEndpoint: new URL('https://bedrock-agentcore.us-east-1.amazonaws.com'),
        s3Endpoint: new URL(fake.url),
      }),
    });

  const object = (bytes: Buffer) => (res: import('node:http').ServerResponse) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(bytes.length) });
    res.end(bytes);
  };

  it('signs GetObject for <prefix>runs/<runId>.json and serves the record', async () => {
    fake.enqueue(object(J1_BYTES));
    const base = await serve(createRecordHandler(awsDeps()));
    const raw = await send(`${base}${recordPath(J1.runId)}`);
    expect(raw.status).toBe(200);
    expect(raw.body.equals(J1_BYTES)).toBe(true);
    const [request] = fake.requests;
    expect(request.method).toBe('GET');
    expect(request.url).toBe(`/orion-runs-example/orion/runs/${J1.runId}.json`);
    expect(request.headers['x-amz-content-sha256']).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(request.headers['x-amz-security-token']).toBe(TEST_CREDENTIALS.sessionToken);
    expect(String(request.headers.authorization)).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$/,
    );
    const date = String(request.headers['x-amz-date']);
    const expected = signRequest({
      method: 'GET',
      url: new URL(`http://${request.headers.host}${request.url}`),
      headers: {},
      body: '',
      service: 's3',
      region: 'us-east-1',
      credentials: TEST_CREDENTIALS,
      now: new Date(
        `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${date.slice(9, 11)}:${date.slice(11, 13)}:${date.slice(13, 15)}Z`,
      ),
      s3: true,
    });
    expect(request.headers.authorization).toBe(expected.headers.Authorization);
  });

  it('uses the prefix exactly as configured, and the view route applies the lease rule (mode H)', async () => {
    fake.enqueue(object(Buffer.from(JSON.stringify(executingRecord('2026-11-04T15:03:04.200Z')))));
    const base = await serve(createViewHandler(awsDeps('H', 'team/a/')));
    const view = JSON.parse((await send(`${base}${viewPath(J1.runId)}`)).body.toString('utf8')) as RunView;
    expect(fake.requests[0].url).toBe(`/orion-runs-example/team/a/runs/${J1.runId}.json`);
    expect(view.status).toBe('Interrupted');
  });

  it.each([
    [404, '<Error><Code>NoSuchKey</Code></Error>', 404, 'RUN_NOT_FOUND'],
    [403, '<Error><Code>AccessDenied</Code></Error>', 404, 'RUN_NOT_FOUND'],
    [403, '<Error><Code>SignatureDoesNotMatch</Code></Error>', 502, 'UPSTREAM_ERROR'],
    [500, '<Error><Code>InternalError</Code></Error>', 502, 'UPSTREAM_ERROR'],
    [503, '<Error><Code>SlowDown</Code></Error>', 503, 'UPSTREAM_UNAVAILABLE'],
    [429, '', 503, 'UPSTREAM_UNAVAILABLE'],
  ])('maps S3 %i %s to %i %s', async (status, xml, expected, code) => {
    fake.enqueue((res) => {
      res.writeHead(status, { 'Content-Type': 'application/xml' });
      res.end(xml);
    });
    const base = await serve(createViewHandler(awsDeps()));
    const raw = await send(`${base}${viewPath(J1.runId)}`);
    expect(raw.status).toBe(expected);
    expect(bffError(raw).code).toBe(code);
  });

  it('answers 503 when S3 is unreachable or there are no credentials', async () => {
    const port = fake.port;
    await fake.close();
    const unreachable = deps({
      config: (): AwsConfig => ({
        ...(awsDeps().config() as AwsConfig),
        s3Endpoint: new URL(`http://127.0.0.1:${port}`),
      }),
    });
    const base = await serve(createViewHandler(unreachable));
    expect(bffError(await send(`${base}${viewPath(J1.runId)}`)).code).toBe('UPSTREAM_UNAVAILABLE');
    fake = await startFake();
    const noCredentials = await serve(
      createViewHandler({
        ...awsDeps(),
        credentials: async () => {
          throw new Error('No AWS credentials');
        },
      }),
    );
    const raw = await send(`${noCredentials}${viewPath(J1.runId)}`);
    expect(raw.status).toBe(503);
    expect(fake.requests).toHaveLength(0);
  });

  it('answers 404 when the record belongs to another thread', async () => {
    fake.enqueue(answer(200, J1));
    const base = await serve(createRecordHandler(awsDeps()));
    expect((await send(`${base}${recordPath(J1.runId, `?threadId=${OTHER}`)}`)).status).toBe(404);
  });
});
