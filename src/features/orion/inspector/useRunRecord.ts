import { useEffect, useState } from 'react';
import { TransportError, type RunRoutes } from '../agui/transport';
import type { RunRecord } from '../agui/types';

export type RecordState =
  | { state: 'loading' }
  | { state: 'ready'; record: RunRecord }
  /**
   * No record route (a fixture replay); RUN_NOT_FOUND, the record is not stored (yet); or
   * UNAUTHENTICATED, the session ended, so the run cannot be read.
   */
  | { state: 'unavailable'; reason: 'no-route' | 'not-stored' | 'signed-out' }
  | { state: 'error'; message: string };

/**
 * The run record from the record route, read again when the run's revision rises (the record is
 * rewritten after every transition). RUN_NOT_FOUND says the record is not available, and
 * UNAUTHENTICATED that it cannot be read until the researcher signs in again, per the contract's
 * client handling.
 */
export const useRunRecord = (
  routes: RunRoutes | null,
  runId: string,
  threadId: string,
  revision: number | null,
): RecordState => {
  const [result, setResult] = useState<RecordState>(
    routes ? { state: 'loading' } : { state: 'unavailable', reason: 'no-route' },
  );
  useEffect(() => {
    if (!routes) {
      setResult({ state: 'unavailable', reason: 'no-route' });
      return undefined;
    }
    const controller = new AbortController();
    setResult((previous) => (previous.state === 'ready' && previous.record.runId === runId ? previous : { state: 'loading' }));
    routes.record(runId, threadId, controller.signal).then(
      (record) => {
        if (!controller.signal.aborted) setResult({ state: 'ready', record });
      },
      (err: unknown) => {
        if (controller.signal.aborted) return;
        if (err instanceof TransportError && err.bffCode === 'RUN_NOT_FOUND') {
          setResult({ state: 'unavailable', reason: 'not-stored' });
        } else if (err instanceof TransportError && err.bffCode === 'UNAUTHENTICATED') {
          setResult({ state: 'unavailable', reason: 'signed-out' });
        } else {
          setResult({ state: 'error', message: err instanceof Error ? err.message : 'The record could not be read' });
        }
      },
    );
    return () => controller.abort();
  }, [routes, runId, threadId, revision]);
  return result;
};
