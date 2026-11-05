// The turn body (contract "Request: RunAgentInput"). The BFF checks the envelope it routes on and
// forwards the bytes unchanged; each action's payload is the agent's to validate (its RUN_ERROR
// INVALID_INPUT comes back in the stream).

import type { IncomingMessage } from 'node:http';
import { ACTION_STATUSES, type OrionActionName } from '../agui/types';
import { isId } from '../ids';
import { BffFailure } from './errors';
import { BodyTooLargeError, readBody } from './httpClient';

/** A turn's cohort context can carry saved case-ID lists; 8 MiB matches the identity gateway's cap. */
export const MAX_TURN_BYTES = 8 * 1024 * 1024;

export const ORION_ACTIONS = [
  'warmup',
  'ask',
  ...(Object.keys(ACTION_STATUSES) as (keyof typeof ACTION_STATUSES)[]),
] as const satisfies readonly OrionActionName[];

const ACTIONS: ReadonlySet<string> = new Set(ORION_ACTIONS);

/** Actions that abort an open upstream call for their thread instead of being refused as busy. */
export const PREEMPTING_ACTIONS: ReadonlySet<OrionActionName> = new Set(['cancel', 'edit_plan', 'confirm']);

export interface Turn {
  threadId: string;
  runId: string;
  action: OrionActionName;
  /** The request body exactly as received. */
  bytes: Buffer;
}

const invalid = (message: string): BffFailure => new BffFailure('INVALID_INPUT', message);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const JSON_TYPE = /^application\/json\s*(;|$)/i;

/** Parses and checks a received body. */
export const parseTurn = (bytes: Buffer): Turn => {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw invalid('The body is not JSON.');
  }
  if (!isObject(value)) throw invalid('The body must be a RunAgentInput object.');
  const { threadId, runId } = value;
  // Ids first, before anything else (contract "BFF routes", Ids).
  if (!isId(threadId) || !isId(runId)) throw invalid('threadId and runId must be 32 lowercase hex characters.');
  if (!isObject(value.state)) throw invalid('state must be an object.');
  for (const field of ['messages', 'tools', 'context'] as const) {
    if (!Array.isArray(value[field])) throw invalid(`${field} must be an array.`);
  }
  const { forwardedProps } = value;
  if (!isObject(forwardedProps) || !isObject(forwardedProps.orion)) {
    throw invalid('forwardedProps.orion must be an object.');
  }
  const { action } = forwardedProps.orion;
  if (typeof action !== 'string' || !ACTIONS.has(action)) throw invalid('forwardedProps.orion.action is not an ORION action.');
  return { threadId, runId, action: action as OrionActionName, bytes };
};

/** Reads the request body (bodyParser is off) and parses it. */
export const readTurn = async (req: IncomingMessage): Promise<Turn> => {
  if (!JSON_TYPE.test(req.headers['content-type'] ?? '')) throw invalid('Send the turn as application/json.');
  const encoding = (req.headers['content-encoding'] ?? 'identity').toLowerCase();
  if (encoding !== 'identity') throw invalid('The body must not be compressed.');
  let bytes: Buffer;
  try {
    bytes = await readBody(req, MAX_TURN_BYTES, { discardOverflow: true });
  } catch (err) {
    if (err instanceof BodyTooLargeError) throw invalid('The body is too large.');
    throw invalid('The body could not be read.');
  }
  return parseTurn(bytes);
};

const TRACEPARENT = /^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

/** The browser's W3C `traceparent`, passed on only when well formed. */
export const traceparentOf = (req: IncomingMessage): string | null => {
  const raw = req.headers.traceparent;
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value && TRACEPARENT.test(value.trim()) ? value.trim() : null;
};
