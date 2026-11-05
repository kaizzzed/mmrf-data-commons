// Client-side helpers for the three BFF routes (contract "BFF routes" and "Client handling of BFF
// errors"). Safe to import from the browser: no Node modules, no server state. The route
// handlers import the same codes and statuses, so both sides agree on them.

import {
  BFF_ERROR_HANDLING,
  ORION_ROUTES,
  SSE_RESPONSE_HEADERS,
  type BffError,
  type BffErrorCode,
} from '../agui/types';

/** The six contract codes, in the order of the contract's error table. */
export const BFF_ERROR_CODES = [
  'INVALID_INPUT',
  'RUN_NOT_FOUND',
  'SESSION_BUSY',
  'UPSTREAM_ERROR',
  'UPSTREAM_UNAVAILABLE',
  'UPSTREAM_TIMEOUT',
] as const satisfies readonly BffErrorCode[];

/**
 * The contract's codes plus UNAUTHENTICATED: the routes run the fork's session check first, and
 * the contract's table has no row for a missing session (proposed as a contract change). The
 * browser treats it as a rejected turn whose notice asks the researcher to sign in again.
 */
export type BffRouteErrorCode = BffErrorCode | 'UNAUTHENTICATED';

export interface BffRouteError {
  error: { code: BffRouteErrorCode; message: string };
}

export const BFF_ERROR_STATUS = {
  INVALID_INPUT: 400,
  UNAUTHENTICATED: 401,
  RUN_NOT_FOUND: 404,
  SESSION_BUSY: 409,
  UPSTREAM_ERROR: 502,
  UPSTREAM_UNAVAILABLE: 503,
  UPSTREAM_TIMEOUT: 504,
} as const satisfies Record<BffRouteErrorCode, number>;

/** BFF_ERROR_HANDLING (types.ts) with the session check's code. */
export const BFF_ROUTE_ERROR_HANDLING = {
  ...BFF_ERROR_HANDLING,
  UNAUTHENTICATED: 'reject',
} as const satisfies Record<BffRouteErrorCode, 'reject' | 'pollView' | 'checkView' | 'notStored'>;

export type BffErrorAction = (typeof BFF_ROUTE_ERROR_HANDLING)[BffRouteErrorCode];

const ROUTE_CODES: ReadonlySet<string> = new Set<string>(Object.keys(BFF_ERROR_STATUS));

export const isBffRouteErrorCode = (value: unknown): value is BffRouteErrorCode =>
  typeof value === 'string' && ROUTE_CODES.has(value);

/** Narrows to the contract's own BffError (no UNAUTHENTICATED). */
export const isContractBffError = (error: BffRouteError): error is BffError =>
  error.error.code !== 'UNAUTHENTICATED';

const basePathDefault = (): string => process.env.NEXT_PUBLIC_BASE_PATH ?? '';

export interface RouteOptions {
  /** Defaults to NEXT_PUBLIC_BASE_PATH, as the transport does. */
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
export const parseBffError = (body: unknown): BffRouteError | null => {
  if (typeof body !== 'object' || body === null) return null;
  const error = (body as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return null;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (!isBffRouteErrorCode(code) || typeof message !== 'string') return null;
  return { error: { code, message } };
};

export const isEventStream = (contentType: string | null | undefined): boolean =>
  (contentType ?? '').toLowerCase().startsWith(SSE_RESPONSE_HEADERS['Content-Type'].split(';')[0]);

const isJson = (contentType: string | null): boolean =>
  /^application\/json\b/i.test(contentType ?? '');

/**
 * Reads the BffError of a non-stream response (any route). Never throws and never reads an event
 * stream; null when the body is not a BffError (a redirect, an HTML error page).
 */
export const readBffError = async (response: Response): Promise<BffRouteError | null> => {
  const type = response.headers.get('content-type');
  if (response.ok || isEventStream(type) || !isJson(type)) return null;
  try {
    return parseBffError(await response.json());
  } catch {
    return null;
  }
};
