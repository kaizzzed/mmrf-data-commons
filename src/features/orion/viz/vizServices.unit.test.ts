import { TransportError, type RunRoutes } from '../agui/transport';
import type { RunRecord } from '../agui/types';
import { readRecord } from '../testing';
import { citedCallLoader, citedCallOf, DEFAULT_VIZ_SERVICES } from './vizServices';

const RETRY = readRecord('run-record.j1-retry.json');
const THREAD = RETRY.threadId;

const routesWith = (record: () => Promise<RunRecord>): RunRoutes & { record: jest.Mock } => ({
  view: jest.fn(),
  record: jest.fn(record),
  recordDownloadHref: () => '',
});

describe('citedCallOf', () => {
  it('is the last attempt of the cited step that returned ok (retry_step adds later attempts)', () => {
    const s4 = RETRY.calls.filter((c) => c.stepId === 's4');
    expect(s4.length).toBeGreaterThan(1);
    const last = s4.filter((c) => c.status === 'ok').pop();
    expect(citedCallOf(RETRY.calls, { planVersion: 1, stepId: 's4' })).toEqual({
      callId: last?.callId,
      request: last?.request,
      observed: last?.observed,
    });
    expect(citedCallOf(RETRY.calls, { planVersion: 2, stepId: 's4' })).toBeNull();
  });
});

describe('citedCallLoader (the record route behind a viz card)', () => {
  it('reads the record of the run, for its thread, through the routes', async () => {
    const routes = routesWith(async () => RETRY);
    const call = await citedCallLoader(routes)(THREAD, RETRY.runId, { planVersion: 1, stepId: 's4' });
    expect(routes.record).toHaveBeenCalledWith(RETRY.runId, THREAD);
    expect(call?.callId).toMatch(/\.v1\.s4\.c\d+$/);
  });

  it('has no cited call without a record route (a replay) or before the record is stored', async () => {
    expect(await citedCallLoader(null)(THREAD, RETRY.runId, { planVersion: 1, stepId: 's4' })).toBeNull();
    const notStored = routesWith(async () => {
      throw new TransportError('BFF_ERROR', 'no such run', 404, 'RUN_NOT_FOUND');
    });
    expect(await citedCallLoader(notStored)(THREAD, RETRY.runId, { planVersion: 1, stepId: 's4' })).toBeNull();
  });

  it('rejects any other failure, so the card says the record could not be read', async () => {
    const signedOut = routesWith(async () => {
      throw new TransportError('BFF_ERROR', 'Sign in to use ORION.', 401, 'UNAUTHENTICATED');
    });
    await expect(citedCallLoader(signedOut)(THREAD, RETRY.runId, { planVersion: 1, stepId: 's4' })).rejects.toThrow(
      'Sign in to use ORION.',
    );
  });
});

describe("the default services' record route", () => {
  const env = process.env;
  afterEach(() => {
    process.env = env;
    jest.restoreAllMocks();
  });

  it("reads the record under the app's base path, for the card's thread, and parses a BffError", async () => {
    process.env = { ...env, NEXT_PUBLIC_BASE_PATH: '/lab' };
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(RETRY), { headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: 'RUN_NOT_FOUND', message: 'not stored' } }), {
          status: 404,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
        }),
      );
    const origin = { planVersion: 1, stepId: 's4' };
    expect((await DEFAULT_VIZ_SERVICES.loadCitedCall(THREAD, RETRY.runId, origin))?.callId).toMatch(/\.v1\.s4\.c\d+$/);
    expect(fetchSpy.mock.calls[0][0]).toBe(`/lab/api/orion/runs/${RETRY.runId}/record?threadId=${THREAD}`);
    expect(await DEFAULT_VIZ_SERVICES.loadCitedCall(THREAD, RETRY.runId, origin)).toBeNull();
  });
});
