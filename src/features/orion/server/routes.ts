// Client-side helpers for the three BFF routes (contract "BFF routes" and "Client handling of BFF
// errors"). Safe to import from the browser: no Node modules, no server state. The route
// handlers import the same codes and statuses, and the transport the same parser, so both sides
// agree on them.

import {
  BFF_ERROR_HANDLING,
  ORION_ROUTES,
  SSE_RESPONSE_HEADERS,
  type BffError,
  type BffErrorCode,
} from '../agui/types';

/** The contract's codes, in the order of its error table. */
export const BFF_ERROR_CODES = [
  'INVALID_INPUT',
  'UNAUTHENTICATED',
  'RUN_NOT_FOUND',
  'SESSION_BUSY',
  'UPSTREAM_ERROR',
  'UPSTREAM_UNAVAILABLE',
  'UPSTREAM_TIMEOUT',
] as const satisfies readonly BffErrorCode[];

/** The HTTP status of each code (INVALID_INPUT also answers 405 for a wrong method). */
export const BFF_ERROR_STATUS = {
  INVALID_INPUT: 400,
  UNAUTHENTICATED: 401,
  RUN_NOT_FOUND: 404,
  SESSION_BUSY: 409,
  UPSTREAM_ERROR: 502,
  UPSTREAM_UNAVAILABLE: 503,
  UPSTREAM_TIMEOUT: 504,
} as const satisfies Record<BffErrorCode, number>;

/** What the browser does with a BffError (types.ts BFF_ERROR_HANDLING). */
export type BffErrorAction = (typeof BFF_ERROR_HANDLING)[BffErrorCode];

const CODES: ReadonlySet<string> = new Set<string>(BFF_ERROR_CODES);

export const isBffErrorCode = (value: unknown): value is BffErrorCode => typeof value === 'string' && CODES.has(value);

const basePathDefault = (): string => process.env.NEXT_PUBLIC_BASE_PATH ?? '';

export interface RouteOptions {
  /** Defaults to NEXT_PUBLIC_BASE_PATH, the prefix every route of the app is served under. */
  basePath?: string;
}

export interface ReadRouteOptions extends RouteOptions {
  /** When given, the route answers RUN_NOT_FOUND unless the record belongs to this thread. */
  threadId?: string;
}

export const aguiUrl = ({ basePath = basePathDefault() }: RouteOptions = {}): string =>
  `${basePath}${ORION_ROUTES.agui}`;

const withQuery = (path: string, query: Record<string, string | undefined>): string => {
  const params = new URLSearchParams();
  for (const [key, val] of Object.entries(query)) if (val !== undefined) params.set(key, val);
  const search = params.toString();
  return search ? `${path}?${search}` : path;
};

export const viewUrl = (runId: string, { basePath = basePathDefault(), threadId }: ReadRouteOptions = {}): string =>
  withQuery(`${basePath}${ORION_ROUTES.view(encodeURIComponent(runId))}`, { threadId });

export const recordUrl = (
  runId: string,
  { basePath = basePathDefault(), threadId, download = false }: ReadRouteOptions & { download?: boolean } = {},
): string =>
  withQuery(`${basePath}${ORION_ROUTES.record(encodeURIComponent(runId))}`, {
    threadId,
    download: download ? '1' : undefined,
  });

/** The `Content-Disposition` filename the record route sets with `?download=1`. */
export const recordFilename = (runId: string): string => `orion-run-${runId}.json`;

/** Parses a BffError body; null for anything else (the caller then reports a plain HTTP error). */
export const parseBffError = (body: unknown): BffError | null => {
  if (typeof body !== 'object' || body === null) return null;
  const error = (body as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return null;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (!isBffErrorCode(code) || typeof message !== 'string') return null;
  return { error: { code, message } };
};

/** Whether a Content-Type is the agui route's stream (`text/event-stream`, any parameters). */
export const isEventStream = (contentType: string | null | undefined): boolean =>
  (contentType ?? '').toLowerCase().startsWith(SSE_RESPONSE_HEADERS['Content-Type'].split(';')[0]);

const isJson = (contentType: string | null): boolean =>
  /^application\/json\b/i.test(contentType ?? '');

/**
 * Reads the BffError of a non-stream response (any route). Never throws and never reads an event
 * stream; null when the body is not a BffError (a redirect, an HTML error page).
 */
export const readBffError = async (response: Response): Promise<BffError | null> => {
  const type = response.headers.get('content-type');
  if (response.ok || isEventStream(type) || !isJson(type)) return null;
  try {
    return parseBffError(await response.json());
  } catch {
    return null;
  }
};
