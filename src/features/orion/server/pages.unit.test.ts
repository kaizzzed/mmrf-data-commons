/** @jest-environment node */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { apiResolver } from 'next/dist/server/api-utils/node/api-resolver';
import { getLoginStatus } from '@/lib/auth/getLoginStatus';
import * as aguiPage from '@/pages/api/orion/agui';
import * as recordPage from '@/pages/api/orion/runs/[runId]/record';
import * as viewPage from '@/pages/api/orion/runs/[runId]/view';
import type { RunRecord } from '../agui/types';
import { setLogger, type Logger } from './log';
import {
  bffError,
  listen,
  postTurn,
  readFixture,
  RUN_ROUTE,
  send,
  startFake,
  streamChunks,
  type Fake,
  type Listening,
} from './testHarness';

// The pages run the fork's own session check; only its token verification is replaced here.
jest.mock('@/lib/auth/getLoginStatus', () => ({ getLoginStatus: jest.fn() }));
const loginStatus = jest.mocked(getLoginStatus);

const PREVIEW = { previewModeId: '', previewModeEncryptionKey: '', previewModeSigningKey: '', dev: false };

/** Serves a page module through Next.js's own API resolver, as `next start` does. */
const servePage = (page: unknown): Promise<Listening> =>
  listen(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://test.invalid');
    const query: Record<string, string> = Object.fromEntries(url.searchParams);
    const match = RUN_ROUTE.exec(url.pathname);
    if (match) query.runId = match[1];
    await apiResolver(req, res, query, page, PREVIEW, false);
  });

const J1 = readFixture('j1-complete.events.jsonl');
const RECORD_BYTES = readFixture('run-record.j1-complete.json');
const RECORD = JSON.parse(RECORD_BYTES.toString('utf8')) as RunRecord;
const ASK = JSON.stringify(
  (
    JSON.parse(readFixture('request-examples.json').toString('utf8')) as {
      examples: { body: { forwardedProps: { orion: { action: string } } } }[];
    }
  ).examples.find((e) => e.body.forwardedProps.orion.action === 'ask')?.body,
);

const ENV_KEYS = ['ORION_MODE', 'ORION_AGENT_URL', 'ORION_RUN_DIR'] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

let fake: Fake;
let server: Listening | undefined;
let runDir: string;
let restore: Logger;

beforeEach(async () => {
  restore = setLogger(() => undefined);
  fake = await startFake();
  runDir = mkdtempSync(path.join(tmpdir(), 'orion-pages-'));
  mkdirSync(path.join(runDir, 'runs'));
  writeFileSync(path.join(runDir, 'runs', `${RECORD.runId}.json`), RECORD_BYTES);
  Object.assign(process.env, { ORION_MODE: 'L', ORION_AGENT_URL: fake.url, ORION_RUN_DIR: runDir });
  loginStatus.mockResolvedValue({ status: 'issued' });
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  await fake.close();
  rmSync(runDir, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = savedEnv[key];
  }
  setLogger(restore);
});

describe('the page modules under src/pages/api/orion', () => {
  it('turn off the body parser for the turn route and the response limit everywhere', () => {
    expect(aguiPage.config).toEqual({ api: { bodyParser: false, responseLimit: false } });
    expect(viewPage.config).toEqual({ api: { responseLimit: false } });
    expect(recordPage.config).toEqual({ api: { responseLimit: false } });
  });

  it('relay a turn through Next.js unchanged in both directions', async () => {
    server = await servePage(aguiPage);
    fake.enqueue(streamChunks(J1));
    const raw = await postTurn(server.url, ASK, { Cookie: 'access_token=from-the-gateway' });
    expect(raw.status).toBe(200);
    expect(raw.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(raw.body.equals(J1)).toBe(true);
    expect(fake.requests[0].body.toString('utf8')).toBe(ASK);
    expect(loginStatus).toHaveBeenCalledWith('access_token=from-the-gateway');
  });

  it.each([['expired'], ['invalid'], ['not present']] as const)(
    'answer 401 when the session is %s, on every route',
    async (status) => {
      loginStatus.mockResolvedValue({ status });
      for (const [page, request] of [
        [aguiPage, (base: string) => postTurn(base, ASK)],
        [viewPage, (base: string) => send(`${base}/api/orion/runs/${RECORD.runId}/view`)],
        [recordPage, (base: string) => send(`${base}/api/orion/runs/${RECORD.runId}/record`)],
      ] as const) {
        await server?.close();
        server = await servePage(page);
        const raw = await request(server.url);
        expect(raw.status).toBe(401);
        expect(bffError(raw).code).toBe('UNAUTHENTICATED');
      }
      expect(fake.requests).toHaveLength(0);
    },
  );

  it('serve the view and the record from ORION_RUN_DIR', async () => {
    server = await servePage(viewPage);
    const view = await send(`${server.url}/api/orion/runs/${RECORD.runId}/view?threadId=${RECORD.threadId}`);
    expect(view.status).toBe(200);
    expect(JSON.parse(view.body.toString('utf8'))).toEqual(RECORD.runView);
    await server.close();
    server = await servePage(recordPage);
    const record = await send(`${server.url}/api/orion/runs/${RECORD.runId}/record?download=1`);
    expect(record.status).toBe(200);
    expect(record.headers['content-disposition']).toBe(`attachment; filename="orion-run-${RECORD.runId}.json"`);
    expect(record.body.equals(RECORD_BYTES)).toBe(true);
  });
});
