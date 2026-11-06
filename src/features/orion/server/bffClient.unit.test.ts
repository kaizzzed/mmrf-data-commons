/** @jest-environment node */
// The BFF and the browser client agree (contract "BFF routes" and "Client handling of BFF
// errors"): the real page modules under src/pages/api/orion, served through Next.js's own API
// resolver in mode L against a fake agent that streams the fixture bytes, read by the real
// httpTransport, httpRoutes, run controller and thread reducer over Node's fetch.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { apiResolver } from 'next/dist/server/api-utils/node/api-resolver';
import { getLoginStatus } from '@/lib/auth/getLoginStatus';
import * as aguiPage from '@/pages/api/orion/agui';
import * as recordPage from '@/pages/api/orion/runs/[runId]/record';
import * as viewPage from '@/pages/api/orion/runs/[runId]/view';
import { latestRunId } from '../agui/reducer';
import { createSseParser } from '../agui/sseParser';
import { httpRoutes, httpTransport, TransportError, type RunTransport } from '../agui/transport';
import {
  ORION_ROUTES,
  RUNTIME_SESSION_HEADER,
  runtimeSessionId,
  SSE_RESPONSE_HEADERS,
  type AguiEvent,
  type BffErrorCode,
  type CohortContext,
  type RunAgentInput,
  type RunRecord,
  type RunView,
} from '../agui/types';
import { createRunController, FOLLOW_POLL_MS } from '../controller/runController';
import { activeThread, createTab, tabReducer, type TabAction, type TabState } from '../state/tab';
import { setLogger, type Logger } from './log';
import { aguiUrl, BFF_ERROR_STATUS, readBffError, recordFilename } from './routes';
import {
  answer,
  deferred,
  listen,
  readFixture,
  RUN_ROUTE,
  SSE_HEADERS,
  sseFrames,
  startFake,
  streamChunks,
  type Fake,
  type Listening,
} from './testHarness';

// The pages run the fork's own session check; only its token verification is replaced here.
jest.mock('@/lib/auth/getLoginStatus', () => ({ getLoginStatus: jest.fn() }));
const loginStatus = jest.mocked(getLoginStatus);

/** Ids the browser makes up, fed in order (the run and message ids of a turn). */
const mockIds: string[] = [];
jest.mock('../ids', () => {
  const actual = jest.requireActual<typeof import('../ids')>('../ids');
  return { ...actual, newId: () => mockIds.shift() ?? actual.newId() };
});

const PREVIEW = { previewModeId: '', previewModeEncryptionKey: '', previewModeSigningKey: '', dev: false };

/** The three page modules on one origin, as `next start` serves them. */
const serveBff = (): Promise<Listening> =>
  listen(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://bff.invalid');
    const query: Record<string, string> = Object.fromEntries(url.searchParams);
    const match = RUN_ROUTE.exec(url.pathname);
    if (match) query.runId = match[1];
    const page = url.pathname === ORION_ROUTES.agui ? aguiPage : match ? (url.pathname.endsWith('/view') ? viewPage : recordPage) : null;
    if (!page) {
      res.writeHead(404);
      res.end();
      return;
    }
    await apiResolver(req, res, query, page, PREVIEW, false);
  });

const J1_BYTES = readFixture('j1-complete.events.jsonl');
const RECORD_BYTES = readFixture('run-record.j1-complete.json');
const RECORD = JSON.parse(RECORD_BYTES.toString('utf8')) as RunRecord;
const THREAD = RECORD.threadId;
const RUN = RECORD.runId;
const OTHER_THREAD = 'f'.repeat(32);

const fixtureEvents = (bytes: Buffer): AguiEvent[] =>
  createSseParser()
    .push(new Uint8Array(bytes))
    .map((item) => {
      if (item.kind !== 'event') throw new Error(item.error.message);
      return item.event;
    });

const J1_EVENTS = fixtureEvents(J1_BYTES);
const J1_VIEWS = J1_EVENTS.flatMap((e) => (e.type === 'STATE_SNAPSHOT' ? [e.snapshot] : []));
const QUESTION = J1_VIEWS[0].question;
const COHORTS: CohortContext = {
  active: { id: 'c-all', name: 'All cases', filters: { mode: 'and', root: {} }, caseCount: 1000 },
  saved: [{ id: 'c-all', name: 'Cohort', filters: { mode: 'and', root: {} }, caseCount: 1000 }],
};

const askInput = (threadId = THREAD, runId = RUN): RunAgentInput => ({
  threadId,
  runId,
  state: {},
  messages: [{ id: 'a1'.repeat(16), role: 'user', content: QUESTION }],
  tools: [],
  context: [],
  forwardedProps: { orion: { action: 'ask', question: QUESTION, cohortContext: COHORTS } },
});

const ENV_KEYS = ['ORION_MODE', 'ORION_AGENT_URL', 'ORION_RUN_DIR'] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

let fake: Fake;
let bff: Listening;
let runDir: string;
let restoreLogger: Logger;

const writeRecord = (record: RunRecord | Buffer) =>
  writeFileSync(
    path.join(runDir, 'runs', `${Buffer.isBuffer(record) ? RUN : record.runId}.json`),
    Buffer.isBuffer(record) ? record : JSON.stringify(record),
  );

/** The browser's client on the BFF's origin: the real transport and routes over Node's fetch. */
const client = () => {
  const routes = httpRoutes({ basePath: bff.url, fetchImpl: fetch });
  return { routes, transport: httpTransport({ url: aguiUrl({ basePath: bff.url }), fetchImpl: fetch, routes }) };
};

const collect = async (transport: RunTransport, input: RunAgentInput): Promise<AguiEvent[]> => {
  const events: AguiEvent[] = [];
  for await (const item of transport.run(input, new AbortController().signal)) {
    if (item.kind === 'error') throw new Error(item.error.message);
    events.push(item.event);
  }
  return events;
};

const failure = async (promise: Promise<unknown>): Promise<TransportError> => {
  try {
    await promise;
  } catch (err) {
    if (err instanceof TransportError) return err;
    throw err;
  }
  throw new Error('expected a TransportError');
};

/** A tab driven by the real controller and reducer, as the Assistant drives it. */
const browserTab = (transport: RunTransport) => {
  let tab: TabState = createTab(THREAD);
  const dispatch = (action: TabAction) => {
    tab = tabReducer(tab, action);
  };
  const controller = createRunController(transport, dispatch);
  return { controller, thread: () => activeThread(tab) };
};

const until = async (check: () => boolean, ms = 8000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

beforeEach(async () => {
  restoreLogger = setLogger(() => undefined);
  fake = await startFake();
  bff = await serveBff();
  runDir = mkdtempSync(path.join(tmpdir(), 'orion-bff-client-'));
  mkdirSync(path.join(runDir, 'runs'));
  Object.assign(process.env, { ORION_MODE: 'L', ORION_AGENT_URL: fake.url, ORION_RUN_DIR: runDir });
  loginStatus.mockResolvedValue({ status: 'issued' });
  mockIds.length = 0;
});

afterEach(async () => {
  await bff.close();
  await fake.close();
  rmSync(runDir, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = savedEnv[key];
  }
  setLogger(restoreLogger);
});

jest.setTimeout(20_000);

describe('the BFF pages in mode L, read by the browser client', () => {
  it("relay a turn's bytes both ways unchanged; the transport parses exactly the fixture's events", async () => {
    fake.enqueue(streamChunks(J1_BYTES));
    const { transport } = client();
    const input = askInput();
    const events = await collect(transport, input);
    expect(events).toEqual(J1_EVENTS);
    // The agent got the browser's bytes, with the session header and Accept the contract names.
    const [sent] = fake.requests;
    expect(sent.method).toBe('POST');
    expect(sent.url).toBe('/invocations');
    expect(sent.body.toString('utf8')).toBe(JSON.stringify(input));
    expect(sent.headers[RUNTIME_SESSION_HEADER.toLowerCase()]).toBe(runtimeSessionId(THREAD));
    expect(sent.headers.accept).toBe('text/event-stream');
    expect(sent.headers['content-type']).toBe('application/json');
    expect(sent.headers.cookie).toBeUndefined();
  });

  it('answer a turn with the SSE headers the transport accepts', async () => {
    fake.enqueue(streamChunks(J1_BYTES));
    const response = await fetch(aguiUrl({ basePath: bff.url }), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(askInput()),
    });
    expect(response.status).toBe(200);
    for (const [name, value] of Object.entries(SSE_RESPONSE_HEADERS)) expect(response.headers.get(name)).toBe(value);
    expect(Buffer.from(await response.arrayBuffer()).equals(J1_BYTES)).toBe(true);
  });

  it('take a J1 ask from the controller to a Complete run in the reducer', async () => {
    fake.enqueue(streamChunks(J1_BYTES));
    const { transport } = client();
    const tab = browserTab(transport);
    mockIds.push(RUN, 'a1'.repeat(16));
    tab.controller.ask(THREAD, QUESTION, COHORTS);
    await until(() => tab.thread().runs[RUN]?.status === 'Complete');
    const run = tab.thread().runs[RUN];
    expect(run.view).toEqual(J1_VIEWS[J1_VIEWS.length - 1]);
    expect(run.messages).toHaveLength(1);
    expect(run.transportError).toBeNull();
    expect(tab.thread().notice).toBeNull();
    expect(fake.requests[0].body.toString('utf8')).toBe(JSON.stringify(askInput()));
    tab.controller.dispose();
  });

  it("serve the view and the record as httpRoutes reads them, for the run's thread only", async () => {
    writeRecord(RECORD_BYTES);
    const { routes } = client();
    expect(await routes.view(RUN, THREAD)).toEqual(RECORD.runView);
    expect(await routes.record(RUN, THREAD)).toEqual(RECORD);
    for (const read of [() => routes.view(RUN, OTHER_THREAD), () => routes.record('0'.repeat(32), THREAD)]) {
      const err = await failure(read());
      expect([err.code, err.status, err.bffCode]).toEqual(['BFF_ERROR', 404, 'RUN_NOT_FOUND']);
    }
    const download = await fetch(new URL(routes.recordDownloadHref(RUN, THREAD), bff.url));
    expect(download.headers.get('content-disposition')).toBe(`attachment; filename="${recordFilename(RUN)}"`);
    expect(download.headers.get('cache-control')).toBe('no-store');
    expect(Buffer.from(await download.arrayBuffer()).equals(RECORD_BYTES)).toBe(true);
  });

  it('restore a run whose lease lapsed as Interrupted, as the controller will record it', async () => {
    const executing = J1_VIEWS[5];
    writeRecord({
      ...RECORD,
      status: 'Executing',
      revision: executing.revision,
      updatedAt: executing.updatedAt,
      lease: { owner: 'gone', renewedAt: '2026-11-04T15:00:00.000Z', expiresAt: '2026-11-04T15:03:00.000Z' },
      runView: executing,
    });
    const tab = browserTab(client().transport);
    tab.controller.restore(THREAD, [RUN], RUN);
    await until(() => tab.thread().runs[RUN]?.status === 'Interrupted');
    const view = tab.thread().runs[RUN].view as RunView;
    expect(view.revision).toBe(executing.revision + 1);
    expect(view.code).toBe('RUN_INTERRUPTED');
    expect(view.steps.find((s) => s.id === 's4')?.status).toBe('Failed');
    tab.controller.dispose();
  });

  it('end a stream the agent dropped with no terminal event; the controller follows the run through the view route', async () => {
    // The agent writes its record as it goes; the stream breaks at s4.
    const live = J1_VIEWS[5];
    const lease = { owner: 'here', renewedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 180_000).toISOString() };
    writeRecord({ ...RECORD, status: 'Executing', revision: live.revision, lease, runView: live });
    const frames = sseFrames(J1_BYTES);
    fake.enqueue(async (res) => {
      res.writeHead(200, SSE_HEADERS);
      res.end(Buffer.concat(frames.slice(0, 15)));
    });
    const tab = browserTab(client().transport);
    mockIds.push(RUN, 'a1'.repeat(16));
    tab.controller.ask(THREAD, QUESTION, COHORTS);
    await until(() => tab.thread().runs[RUN]?.transportError?.code === 'STREAM_ENDED');
    expect(tab.thread().runs[RUN].status).toBe('Executing');
    // The run finishes on the agent; the next poll of the view route shows it.
    writeRecord(RECORD_BYTES);
    await until(() => tab.thread().runs[RUN]?.status === 'Complete', FOLLOW_POLL_MS * 3);
    expect(tab.thread().runs[RUN].transportError).toBeNull();
    expect(latestRunId(tab.thread())).toBe(RUN);
    tab.controller.dispose();
  });
});

describe('every BFF error reaches the transport as its contract code and status', () => {
  const expectBffError = (err: TransportError, code: BffErrorCode) =>
    expect([err.code, err.status, err.bffCode]).toEqual(['BFF_ERROR', BFF_ERROR_STATUS[code], code]);

  it('UNAUTHENTICATED (401) on every route, before anything reaches the agent', async () => {
    loginStatus.mockResolvedValue({ status: 'expired' });
    writeRecord(RECORD_BYTES);
    const { transport, routes } = client();
    expectBffError(await failure(collect(transport, askInput())), 'UNAUTHENTICATED');
    expectBffError(await failure(routes.view(RUN, THREAD)), 'UNAUTHENTICATED');
    expectBffError(await failure(routes.record(RUN, THREAD)), 'UNAUTHENTICATED');
    expect(fake.requests).toHaveLength(0);
  });

  it('INVALID_INPUT (400) for a malformed id, and for a wrong method (405, with Allow)', async () => {
    const { transport } = client();
    expectBffError(await failure(collect(transport, askInput('not-an-id'))), 'INVALID_INPUT');
    const wrong = await fetch(aguiUrl({ basePath: bff.url }), { method: 'GET' });
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get('allow')).toBe('POST');
    expect((await readBffError(wrong))?.error.code).toBe('INVALID_INPUT');
    expect(fake.requests).toHaveLength(0);
  });

  it.each([
    [503, 'UPSTREAM_UNAVAILABLE'],
    [429, 'UPSTREAM_UNAVAILABLE'],
    [500, 'UPSTREAM_ERROR'],
  ] as const)('an agent %i before the stream starts is %s, a JSON body with no-store', async (status, code) => {
    fake.enqueue(answer(status));
    const err = await failure(collect(client().transport, askInput()));
    expectBffError(err, code);
    // What the transport read was the BFF's JSON error body, never a stream.
    fake.enqueue(answer(status));
    const raw = await fetch(aguiUrl({ basePath: bff.url }), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(askInput()),
    });
    expect(raw.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(raw.headers.get('cache-control')).toBe('no-store');
    expect((await raw.json()) as unknown).toEqual({ error: { code, message: expect.any(String) } });
  });

  it('SESSION_BUSY (409) for a second turn while the thread holds the session; a cancel goes through', async () => {
    const hold = deferred();
    fake.enqueue(async (res) => {
      res.writeHead(200, SSE_HEADERS);
      res.write(sseFrames(J1_BYTES)[0]);
      await hold.promise;
      res.end();
    });
    const { transport } = client();
    const first = new AbortController();
    const reading = (async () => {
      for await (const item of transport.run(askInput(), first.signal)) void item;
    })().catch(() => undefined);
    await fake.request(0);
    expectBffError(await failure(collect(transport, askInput(THREAD, 'b'.repeat(32)))), 'SESSION_BUSY');
    // A cancel aborts the open call first, then reaches the agent.
    fake.enqueue(streamChunks(readFixture('j1-stop.events.jsonl')));
    const cancel: RunAgentInput = { ...askInput(), messages: [], forwardedProps: { orion: { action: 'cancel' } } };
    const stopped = await collect(transport, cancel);
    expect(stopped.at(-1)).toMatchObject({ type: 'RUN_FINISHED', result: { status: 'Cancelled' } });
    expect(JSON.parse(fake.requests[1].body.toString('utf8'))).toEqual(cancel);
    hold.resolve();
    first.abort();
    await reading;
  });
});
