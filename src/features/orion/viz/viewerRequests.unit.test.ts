import { hostPrefix, INPUT_WINDOW_MS, openViewerTap, type ViewerRequest, viewerTapState } from './viewerRequests';

const HOST = '/protein-paint';

const response = (status: number, body: unknown = {}): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    clone: () => response(status, body),
    json: () => Promise.resolve(body),
  }) as unknown as Response;

let fakeFetch: jest.Mock;
let restore: typeof fetch;

beforeEach(() => {
  restore = globalThis.fetch;
  fakeFetch = jest.fn((input: RequestInfo | URL) =>
    Promise.resolve(String(input).includes('/termdb/DE') ? response(200, { data: { cacheId: 'abc123def456' } }) : response(200)),
  );
  globalThis.fetch = fakeFetch as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = restore;
  document.body.replaceChildren();
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const element = () => {
  const div = document.createElement('div');
  document.body.appendChild(div);
  return div;
};

describe('openViewerTap', () => {
  it('wraps fetch only while a session is open, and passes every call through', async () => {
    const tap = openViewerTap(HOST, () => null, jest.fn());
    expect(viewerTapState().installed).toBe(true);
    expect(globalThis.fetch).not.toBe(fakeFetch);
    await globalThis.fetch('/elsewhere');
    expect(fakeFetch).toHaveBeenCalledWith('/elsewhere', undefined);
    tap.close();
    expect(globalThis.fetch).toBe(fakeFetch);
    expect(viewerTapState()).toEqual({ installed: false, open: 0, mounting: false, waiting: 0 });
  });

  it('gives the requests made during its mount turn to the mounting card, without the query', async () => {
    const seen: ViewerRequest[] = [];
    const tap = openViewerTap(HOST, () => null, (r) => seen.push(r));
    await tap.mountTurn();
    await globalThis.fetch('/protein-paint/termdb/survival?embedder=localhost&filter0=x');
    await globalThis.fetch('/protein-paint/termdb/DE', { method: 'post', body: '{}' });
    await globalThis.fetch('/analysis/v0/_version');
    await flush();
    expect(seen.map((r) => [r.method, r.path, r.status, r.cacheId, r.error])).toEqual([
      ['GET', '/termdb/survival', 200, null, null],
      ['POST', '/termdb/DE', 200, 'abc123def456', null],
    ]);
    expect(seen.every((r) => r.ms >= 0)).toBe(true);
    tap.mountDone();
    await globalThis.fetch('/protein-paint/termdb/survival');
    expect(seen).toHaveLength(2);
    tap.close();
  });

  it('starts viewers one at a time, in order, and skips a closed one', async () => {
    const first = openViewerTap(HOST, () => null, jest.fn());
    const second = openViewerTap(HOST, () => null, jest.fn());
    const third = openViewerTap(HOST, () => null, jest.fn());
    const order: string[] = [];
    void first.mountTurn().then(() => order.push('first'));
    void second.mountTurn().then(() => order.push('second'));
    void third.mountTurn().then(() => order.push('third'));
    await flush();
    expect(order).toEqual(['first']);
    second.close();
    first.mountDone();
    await flush();
    expect(order).toEqual(['first', 'third']);
    third.close();
    first.close();
    expect(viewerTapState()).toEqual({ installed: false, open: 0, mounting: false, waiting: 0 });
  });

  it('closing the mounting card hands the turn on', async () => {
    const first = openViewerTap(HOST, () => null, jest.fn());
    const second = openViewerTap(HOST, () => null, jest.fn());
    await first.mountTurn();
    let started = false;
    void second.mountTurn().then(() => {
      started = true;
    });
    await flush();
    expect(started).toBe(false);
    first.close();
    await flush();
    expect(started).toBe(true);
    second.close();
  });

  it('gives a later request to the card the researcher last clicked, within the input window', async () => {
    const a = element();
    const b = element();
    const seenA: ViewerRequest[] = [];
    const seenB: ViewerRequest[] = [];
    const tapA = openViewerTap(HOST, () => a, (r) => seenA.push(r));
    const tapB = openViewerTap(HOST, () => b, (r) => seenB.push(r));
    await globalThis.fetch('/protein-paint/termdb/DE');
    expect(seenA.length + seenB.length).toBe(0);
    const inner = document.createElement('button');
    b.appendChild(inner);
    inner.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await globalThis.fetch('/protein-paint/termdb/DE');
    await flush();
    expect(seenB).toHaveLength(1);
    a.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }));
    await globalThis.fetch('/protein-paint/termdb/config');
    expect(seenA.map((r) => r.path)).toEqual(['/termdb/config']);

    const now = jest.spyOn(performance, 'now').mockReturnValue(performance.now() + INPUT_WINDOW_MS + 1);
    await globalThis.fetch('/protein-paint/termdb/config');
    now.mockRestore();
    expect(seenA).toHaveLength(1);
    tapA.close();
    tapB.close();
  });

  it('records a request that fails before a response, and rethrows', async () => {
    fakeFetch.mockImplementationOnce(() => Promise.reject(new Error('aborted')));
    const seen: ViewerRequest[] = [];
    const tap = openViewerTap(HOST, () => null, (r) => seen.push(r));
    await tap.mountTurn();
    await expect(globalThis.fetch('/protein-paint/termdb/matrix')).rejects.toThrow('aborted');
    expect(seen).toMatchObject([{ path: '/termdb/matrix', status: null, error: 'aborted', cacheId: null }]);
    tap.close();
  });

  it('matches the host as a path prefix, not a string prefix', async () => {
    const seen: ViewerRequest[] = [];
    const tap = openViewerTap(HOST, () => null, (r) => seen.push(r));
    await tap.mountTurn();
    await globalThis.fetch('/protein-painting/x');
    await globalThis.fetch(new URL('/protein-paint/genomes', window.location.href));
    expect(seen.map((r) => r.path)).toEqual(['/genomes']);
    expect(hostPrefix('/protein-paint/')).toBe(`${window.location.origin}/protein-paint`);
    tap.close();
  });
});
