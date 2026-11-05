// The viewer's own requests, shown on its card (C-36; FR-06: "viewer-internal requests appear on
// the viz card with cache status"). ProteinPaint's dofetch3 calls the global fetch, so while a
// viewer session is open a pass-through wrapper notes each request under the ProteinPaint host.
// A request has no tie to a DOM element, so attribution is by time: viewers start one at a time
// (the mount turn), and a request outside any start belongs to the card the researcher last
// clicked or typed in, within INPUT_WINDOW_MS. Requests ProteinPaint answers from its in-page
// cache make no fetch and are not seen.

export const INPUT_WINDOW_MS = 10_000;

export interface ViewerRequest {
  /** Unique within the page. */
  id: number;
  method: string;
  /** The path under the ProteinPaint host, without the query string (`/termdb/survival`). */
  path: string;
  /** HTTP status, or null when the request failed before a response. */
  status: number | null;
  ms: number;
  /** A DE run's `data.cacheId`: ProteinPaint's server cache key for that comparison. */
  cacheId: string | null;
  /** Why the request failed before a response, such as an abort. */
  error: string | null;
}

export interface ViewerTap {
  /** Waits for the page's mount turn; until mountDone, every viewer request belongs to this tap. */
  mountTurn(): Promise<void>;
  mountDone(): void;
  close(): void;
}

interface TapState {
  prefix: string;
  element: () => HTMLElement | null;
  onRequest: (request: ViewerRequest) => void;
  lastInput: number;
  closed: boolean;
}

const taps = new Set<TapState>();
let mounting: TapState | null = null;
const waiting: { tap: TapState; start: () => void }[] = [];
let nativeFetch: typeof fetch | null = null;
let nextId = 1;

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

const baseHref = (): string =>
  typeof window !== 'undefined' && window.location ? window.location.href : 'http://localhost/';

/** The absolute URL prefix of a host such as `/protein-paint` or `https://x/protein-paint`. */
export const hostPrefix = (host: string): string => new URL(host, baseHref()).href.replace(/\/+$/, '');

const urlOf = (input: RequestInfo | URL): string | null => {
  try {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return new URL(raw, baseHref()).href;
  } catch {
    return null;
  }
};

const underPrefix = (url: string, prefix: string): boolean =>
  url === prefix || url.startsWith(`${prefix}/`) || url.startsWith(`${prefix}?`);

const pathUnder = (url: string, prefix: string): string => {
  const rest = url.slice(prefix.length).split(/[?#]/)[0];
  return rest === '' ? '/' : rest;
};

const ownerOf = (url: string): TapState | null => {
  if (mounting && underPrefix(url, mounting.prefix)) return mounting;
  let owner: TapState | null = null;
  const cutoff = now() - INPUT_WINDOW_MS;
  for (const tap of Array.from(taps)) {
    if (tap.lastInput >= cutoff && underPrefix(url, tap.prefix) && (!owner || tap.lastInput > owner.lastInput)) {
      owner = tap;
    }
  }
  return owner;
};

const methodOf = (input: RequestInfo | URL, init?: RequestInit): string =>
  (init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')).toUpperCase();

/** A DE run answers `{data: {cacheId}, ...}`; anything else has no cache key. */
const deCacheId = async (response: Response): Promise<string | null> => {
  try {
    const body: unknown = await response.json();
    const data = typeof body === 'object' && body !== null ? (body as { data?: unknown }).data : undefined;
    const cacheId = typeof data === 'object' && data !== null ? (data as { cacheId?: unknown }).cacheId : undefined;
    return typeof cacheId === 'string' ? cacheId : null;
  } catch {
    return null;
  }
};

const tapFetch: typeof fetch = async (input, init) => {
  const native = nativeFetch ?? globalThis.fetch;
  const url = urlOf(input);
  const owner = url ? ownerOf(url) : null;
  if (!owner || !url) return native.call(globalThis, input, init);
  const started = now();
  const method = methodOf(input, init);
  const path = pathUnder(url, owner.prefix);
  const record = (fields: Pick<ViewerRequest, 'status' | 'cacheId' | 'error'>) => {
    if (!owner.closed) owner.onRequest({ id: nextId++, method, path, ms: now() - started, ...fields });
  };
  let response: Response;
  try {
    response = await native.call(globalThis, input, init);
  } catch (error) {
    record({ status: null, cacheId: null, error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
  if (response.ok && path === '/termdb/DE' && typeof response.clone === 'function') {
    // Read a copy, so the viewer's own read of the body is untouched.
    void deCacheId(response.clone()).then((cacheId) => record({ status: response.status, cacheId, error: null }));
  } else {
    record({ status: response.status, cacheId: null, error: null });
  }
  return response;
};

const install = () => {
  if (nativeFetch || typeof globalThis.fetch !== 'function') return;
  nativeFetch = globalThis.fetch;
  globalThis.fetch = tapFetch;
};

const uninstall = () => {
  if (taps.size > 0 || !nativeFetch) return;
  // Someone who wrapped fetch after us keeps their wrapper; ours then passes everything through.
  if (globalThis.fetch === tapFetch) globalThis.fetch = nativeFetch;
  nativeFetch = null;
};

const startNext = () => {
  while (!mounting && waiting.length > 0) {
    const next = waiting.shift();
    if (next && !next.tap.closed) {
      mounting = next.tap;
      next.start();
    }
  }
};

/**
 * Opens a tap for one viewer session. `element` is the card's viewer region: clicks and key
 * presses inside it claim the requests that follow.
 */
export const openViewerTap = (
  host: string,
  element: () => HTMLElement | null,
  onRequest: (request: ViewerRequest) => void,
): ViewerTap => {
  const tap: TapState = { prefix: hostPrefix(host), element, onRequest, lastInput: -Infinity, closed: false };
  const onInput = (event: Event) => {
    const target = tap.element();
    if (target && event.target instanceof Node && target.contains(event.target)) tap.lastInput = now();
  };
  taps.add(tap);
  install();
  if (typeof document !== 'undefined') {
    document.addEventListener('pointerdown', onInput, true);
    document.addEventListener('keydown', onInput, true);
  }
  let turn: Promise<void> | null = null;
  const done = () => {
    if (mounting === tap) {
      mounting = null;
      startNext();
    }
  };
  return {
    mountTurn() {
      if (!turn) {
        turn = new Promise<void>((resolve) => {
          waiting.push({ tap, start: resolve });
          startNext();
        });
      }
      return turn;
    },
    mountDone: done,
    close() {
      if (tap.closed) return;
      tap.closed = true;
      if (typeof document !== 'undefined') {
        document.removeEventListener('pointerdown', onInput, true);
        document.removeEventListener('keydown', onInput, true);
      }
      const queued = waiting.findIndex((w) => w.tap === tap);
      if (queued >= 0) waiting.splice(queued, 1);
      taps.delete(tap);
      done();
      uninstall();
    },
  };
};

/** fetch that no tap sees: for the card's own reads (the mode H fingerprint), never the viewer's. */
export const untappedFetch: typeof fetch = (input, init) => (nativeFetch ?? globalThis.fetch).call(globalThis, input, init);

/** Test support: whether the fetch wrapper is installed, and how many sessions are open. */
export const viewerTapState = (): { installed: boolean; open: number; mounting: boolean; waiting: number } => ({
  installed: nativeFetch !== null,
  open: taps.size,
  mounting: mounting !== null,
  waiting: waiting.length,
});
