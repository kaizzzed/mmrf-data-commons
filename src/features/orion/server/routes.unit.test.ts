import { BFF_ERROR_HANDLING, ORION_ROUTES } from '../agui/types';
import {
  aguiUrl,
  BFF_ERROR_CODES,
  BFF_ERROR_STATUS,
  BFF_ROUTE_ERROR_HANDLING,
  isContractBffError,
  parseBffError,
  readBffError,
  recordFilename,
  recordUrl,
  viewUrl,
} from './routes';

const RUN = 'fedcba9876543210fedcba9876543210';
const THREAD = '0123456789abcdef0123456789abcdef';

describe('BFF route helpers (browser side)', () => {
  it('builds the three routes from ORION_ROUTES, with the base path and query', () => {
    expect(aguiUrl({ basePath: '' })).toBe(ORION_ROUTES.agui);
    expect(aguiUrl({ basePath: '/lab' })).toBe('/lab/api/orion/agui');
    expect(viewUrl(RUN, { basePath: '' })).toBe(`/api/orion/runs/${RUN}/view`);
    expect(viewUrl(RUN, { basePath: '/lab', threadId: THREAD })).toBe(`/lab/api/orion/runs/${RUN}/view?threadId=${THREAD}`);
    expect(recordUrl(RUN, { basePath: '' })).toBe(`/api/orion/runs/${RUN}/record`);
    expect(recordUrl(RUN, { basePath: '', threadId: THREAD, download: true })).toBe(
      `/api/orion/runs/${RUN}/record?threadId=${THREAD}&download=1`,
    );
    expect(viewUrl('a/b', { basePath: '' })).toBe('/api/orion/runs/a%2Fb/view');
    expect(recordFilename(RUN)).toBe(`orion-run-${RUN}.json`);
  });

  it('has a status and a handling for every code, matching the contract table', () => {
    expect(BFF_ERROR_STATUS).toEqual({
      INVALID_INPUT: 400,
      UNAUTHENTICATED: 401,
      RUN_NOT_FOUND: 404,
      SESSION_BUSY: 409,
      UPSTREAM_ERROR: 502,
      UPSTREAM_UNAVAILABLE: 503,
      UPSTREAM_TIMEOUT: 504,
    });
    for (const code of BFF_ERROR_CODES) expect(BFF_ROUTE_ERROR_HANDLING[code]).toBe(BFF_ERROR_HANDLING[code]);
    expect(BFF_ROUTE_ERROR_HANDLING.UNAUTHENTICATED).toBe('reject');
  });

  it('parses BffError bodies and nothing else', () => {
    expect(parseBffError({ error: { code: 'SESSION_BUSY', message: 'busy' } })).toEqual({
      error: { code: 'SESSION_BUSY', message: 'busy' },
    });
    const unauthenticated = parseBffError({ error: { code: 'UNAUTHENTICATED', message: 'Sign in.' }, extra: 1 });
    expect(unauthenticated).toEqual({ error: { code: 'UNAUTHENTICATED', message: 'Sign in.' } });
    expect(unauthenticated && isContractBffError(unauthenticated)).toBe(false);
    for (const body of [
      null,
      'SESSION_BUSY',
      { error: 'Authentication required' },
      { error: { code: 'NOPE', message: 'x' } },
      { error: { code: 'SESSION_BUSY' } },
      { message: 'x' },
    ]) {
      expect(parseBffError(body)).toBeNull();
    }
  });

  it('reads the BffError of a JSON error response, and never an event stream', async () => {
    const json = (status: number, body: unknown, type = 'application/json; charset=utf-8') =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': type } });
    expect(await readBffError(json(409, { error: { code: 'SESSION_BUSY', message: 'busy' } }))).toEqual({
      error: { code: 'SESSION_BUSY', message: 'busy' },
    });
    expect(await readBffError(json(502, { error: 'Bad gateway' }))).toBeNull();
    expect(await readBffError(json(500, {}, 'text/html'))).toBeNull();
    expect(await readBffError(new Response('{', { status: 503, headers: { 'Content-Type': 'application/json' } }))).toBeNull();
    expect(
      await readBffError(new Response('data: {}\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } })),
    ).toBeNull();
  });
});
