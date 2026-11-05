import type { ServerResponse } from 'node:http';
import { BFF_ERROR_STATUS, type BffRouteError, type BffRouteErrorCode } from './routes';

/**
 * An error a route answers with a BffError JSON body (contract "BFF routes", Errors), never an
 * event stream. `status` defaults to the contract's status for the code.
 */
export class BffFailure extends Error {
  readonly code: BffRouteErrorCode;
  readonly status: number;

  constructor(code: BffRouteErrorCode, message: string, status: number = BFF_ERROR_STATUS[code]) {
    super(message);
    this.name = 'BffFailure';
    this.code = code;
    this.status = status;
  }
}

export const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

/** Writes the error body unless the response has already started (then it only ends it). */
export const sendBffError = (
  res: ServerResponse,
  failure: BffFailure,
  extraHeaders: Record<string, string> = {},
): void => {
  if (res.destroyed) return;
  if (res.headersSent) {
    if (!res.writableEnded) res.end();
    return;
  }
  const body: BffRouteError = { error: { code: failure.code, message: failure.message } };
  const text = JSON.stringify(body);
  res.writeHead(failure.status, {
    'Content-Type': JSON_CONTENT_TYPE,
    'Content-Length': String(Buffer.byteLength(text)),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(text);
};

export const methodNotAllowed = (res: ServerResponse, allow: 'GET' | 'POST'): void =>
  sendBffError(res, new BffFailure('INVALID_INPUT', `Use ${allow} for this route.`, 405), { Allow: allow });
