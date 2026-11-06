// Where the view and record routes read run records (contract "Where records live"): the agent's
// volume in mode L, S3 in modes A and H. Read-only: the BFF never writes a record.

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { isId } from '../ids';
import { RUN_STATUSES, type RunStatus, type RunView } from '../agui/types';
import type { BffConfig } from './config';
import type { CredentialProvider } from './credentials';
import { BffFailure } from './errors';
import type { LeaseRecord } from './leaseRule';
import { log } from './log';
import { getObject } from './s3';

/** Records hold every call's full output; this bounds one read, far above a J3 record. */
export const MAX_RECORD_BYTES = 64 * 1024 * 1024;

export interface RecordStore {
  /** The stored bytes, or null when no record exists. Throws BffFailure when the store fails. */
  read(runId: string): Promise<Buffer | null>;
}

const MISSING_CODES: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR']);

export const fileRecordStore = (runDir: string): RecordStore => ({
  async read(runId) {
    const file = path.join(runDir, 'runs', `${runId}.json`);
    try {
      const info = await stat(file);
      if (!info.isFile()) return null;
      if (info.size > MAX_RECORD_BYTES) throw new BffFailure('UPSTREAM_ERROR', 'The run record is too large to serve.');
      return await readFile(file);
    } catch (err) {
      if (err instanceof BffFailure) throw err;
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (MISSING_CODES.has(code)) return null;
      log('warn', 'record_read_failed', { runId, store: 'file', reason: code || 'error' });
      throw new BffFailure('UPSTREAM_UNAVAILABLE', 'Run records cannot be read right now.');
    }
  },
});

export interface S3StoreOptions {
  region: string;
  bucket: string;
  prefix: string;
  endpoint: URL | null;
  credentials: CredentialProvider;
  now?: () => Date;
}

export const recordKey = (prefix: string, runId: string): string => `${prefix}runs/${runId}.json`;

export const s3RecordStore = ({ region, bucket, prefix, endpoint, credentials, now }: S3StoreOptions): RecordStore => ({
  async read(runId) {
    const result = await getObject({ region, bucket, endpoint }, recordKey(prefix, runId), credentials, {
      now,
      maxBytes: MAX_RECORD_BYTES,
    }).catch((err: unknown) => {
      // Only the credential provider throws here.
      log('warn', 'record_read_failed', { runId, store: 's3', reason: err instanceof Error ? err.name : 'error' });
      throw new BffFailure('UPSTREAM_UNAVAILABLE', 'Run records cannot be read right now.');
    });
    switch (result.kind) {
      case 'found':
        return result.body;
      case 'missing':
        if (result.status === 403) {
          // Without s3:ListBucket, S3 answers a missing key with 403 AccessDenied.
          log('info', 'record_access_denied', { runId, store: 's3' });
        }
        return null;
      case 'unavailable':
        log('warn', 'record_read_failed', { runId, store: 's3', status: result.status, reason: result.reason });
        throw new BffFailure('UPSTREAM_UNAVAILABLE', 'Run records cannot be read right now.');
      case 'error':
        log('warn', 'record_read_failed', { runId, store: 's3', status: result.status, reason: result.code });
        throw new BffFailure('UPSTREAM_ERROR', 'The run record store answered with an error.');
    }
  },
});

export const recordStoreFor = (config: BffConfig, credentials: CredentialProvider): RecordStore =>
  config.mode === 'L'
    ? fileRecordStore(config.runDir)
    : s3RecordStore({
        region: config.region,
        bucket: config.runBucket,
        prefix: config.runPrefix,
        endpoint: config.s3Endpoint,
        credentials,
      });

/** What the routes read from a record; the rest of it passes through untouched. */
export interface RecordHead extends Omit<LeaseRecord, 'runView'> {
  schema: 'orion.run-record/v1';
  threadId: string;
  runId: string;
  runView: RunView | null;
}

export interface StoredRecord {
  head: RecordHead;
  /** Exactly as stored: the record route serves these bytes. */
  bytes: Buffer;
}

const STATUSES: ReadonlySet<string> = new Set(RUN_STATUSES);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const malformed = (runId: string, why: string): BffFailure => {
  log('warn', 'record_malformed', { runId, why });
  return new BffFailure('UPSTREAM_ERROR', 'The run record is malformed.');
};

/** Parses and checks the fields the routes rely on. */
export const parseRecord = (runId: string, bytes: Buffer): RecordHead => {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw malformed(runId, 'not JSON');
  }
  if (!isObject(value)) throw malformed(runId, 'not an object');
  const { schema, threadId, revision, status, updatedAt, lease, runView } = value;
  if (schema !== 'orion.run-record/v1') throw malformed(runId, 'schema');
  if (value.runId !== runId || !isId(threadId)) throw malformed(runId, 'ids');
  if (typeof status !== 'string' || !STATUSES.has(status)) throw malformed(runId, 'status');
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0) throw malformed(runId, 'revision');
  if (typeof updatedAt !== 'string') throw malformed(runId, 'updatedAt');
  if (lease !== null && !(isObject(lease) && typeof lease.expiresAt === 'string')) throw malformed(runId, 'lease');
  if (runView !== null) {
    if (!isObject(runView) || runView.runId !== runId || runView.threadId !== threadId) {
      throw malformed(runId, 'runView ids');
    }
    if (!Array.isArray(runView.steps) || !Array.isArray(runView.observed) || !Array.isArray(runView.limitations)) {
      throw malformed(runId, 'runView shape');
    }
  }
  return {
    schema,
    threadId,
    runId,
    revision,
    status: status as RunStatus,
    updatedAt,
    lease: lease === null ? null : { expiresAt: (lease as { expiresAt: string }).expiresAt },
    runView: runView as RunView | null,
  };
};

/**
 * Reads one run record. Null (the route's RUN_NOT_FOUND) when it is not stored, or when
 * `threadId` is given and the record belongs to another thread.
 */
export const loadRecord = async (
  store: RecordStore,
  runId: string,
  threadId: string | null,
): Promise<StoredRecord | null> => {
  const bytes = await store.read(runId);
  if (bytes === null) return null;
  const head = parseRecord(runId, bytes);
  if (threadId !== null && head.threadId !== threadId) return null;
  return { head, bytes };
};
