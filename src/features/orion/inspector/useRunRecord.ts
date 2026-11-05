import { useEffect, useState } from 'react';
import { TransportError, type RunRoutes } from '../agui/transport';
import type { RunRecord } from '../agui/types';

export type RecordState =
  | { state: 'loading' }
  | { state: 'ready'; record: RunRecord }
  /** No record route (a fixture replay), or RUN_NOT_FOUND: the record is not stored (yet). */
  | { state: 'unavailable'; reason: 'no-route' | 'not-stored' }
  | { state: 'error'; message: string };

/**
 * The run record from the record route, read again when the run's revision rises (the record is
 * rewritten after every transition). RUN_NOT_FOUND says the record is not available, per the
 * contract's client handling.
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
        } else {
          setResult({ state: 'error', message: err instanceof Error ? err.message : 'The record could not be read' });
        }
      },
    );
    return () => controller.abort();
  }, [routes, runId, threadId, revision]);
  return result;
};
