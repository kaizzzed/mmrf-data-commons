// What a viz card reads besides its props: the ProteinPaint host, the local fixture fingerprint
// (mode H) and the run record's cited call (the DEinput fallback, the DE cache comparison). Each
// has a default that works in the app; a host or a test overrides them with VizServicesContext.

import { createContext } from 'react';
import { GEN3_API } from '@gen3/core';
import { GEN3_ANALYSIS_API, PROTEINPAINT_API } from '@/core/constants';
import { httpRoutes, TransportError, type RunRoutes } from '../agui/transport';
import type { CallRecord, JsonValue, RunRecord } from '../agui/types';
import { callsOf, type CallOrigin } from '../calls';
import { computeLocalFingerprint, type FingerprintEndpoints } from './fingerprint';
import { MOUNT_TIMEOUT_MS } from './OrionPpCard';
import { untappedFetch } from './viewerRequests';

/** A cited step's recorded call: the last attempt that succeeded. */
export interface CitedCall {
  callId: string;
  request: JsonValue;
  observed: JsonValue;
}

export interface VizServices {
  /** Where the viewers (and the fingerprint's ProteinPaint sources) are read. */
  host: string;
  /** The local fixture fingerprint for mode H, computed once per page. */
  localFingerprint(): Promise<string>;
  /** The cited call from the run record, or null when the record or the call is not there. */
  loadCitedCall(threadId: string, runId: string, origin: CallOrigin): Promise<CitedCall | null>;
  /**
   * The platform's current cohort id, when the host knows it (null: no saved cohort is active).
   * Undefined leaves the hand-off button reading "Open with this cohort".
   */
  activeCohortId?: string | null;
  mountTimeoutMs: number;
}

export const defaultFingerprintEndpoints = (): FingerprintEndpoints => ({
  sandboxStatus: `${GEN3_API}/sandbox/status`,
  analysisVersion: `${GEN3_ANALYSIS_API}/_version`,
  healthcheck: `${PROTEINPAINT_API}/healthcheck`,
  topMutatedGenes: `${PROTEINPAINT_API}/termdb/topMutatedGenes`,
});

let pageFingerprint: Promise<string> | null = null;

/** Computed once per page; a failure is not kept, so a later card tries again. */
export const pageLocalFingerprint = (): Promise<string> => {
  if (!pageFingerprint) {
    // Untapped, so a viewer starting meanwhile is not credited with the fingerprint's requests.
    const attempt = computeLocalFingerprint(defaultFingerprintEndpoints(), untappedFetch).then((f) => f.sha256);
    pageFingerprint = attempt;
    attempt.catch(() => {
      if (pageFingerprint === attempt) pageFingerprint = null;
    });
  }
  return pageFingerprint;
};

/** The last call of the origin step that returned ok (a retry or retry_step adds later attempts). */
export const citedCallOf = (calls: readonly CallRecord[], origin: CallOrigin): CitedCall | null => {
  const ok = callsOf(calls, origin).filter((c) => c.status === 'ok');
  const last = ok[ok.length - 1];
  return last ? { callId: last.callId, request: last.request, observed: last.observed } : null;
};

/**
 * loadCitedCall over the record route (`?threadId=`, the app's base path, BffError parsing): null
 * when there is no route behind the transport (a replay) or the record is not stored yet
 * (RUN_NOT_FOUND); any other failure rejects.
 */
export const citedCallLoader =
  (routes: RunRoutes | null): VizServices['loadCitedCall'] =>
  async (threadId, runId, origin) => {
    if (!routes) return null;
    let record: RunRecord;
    try {
      record = await routes.record(runId, threadId);
    } catch (err) {
      if (err instanceof TransportError && err.bffCode === 'RUN_NOT_FOUND') return null;
      throw err;
    }
    return citedCallOf(record.calls, origin);
  };

export const DEFAULT_VIZ_SERVICES: VizServices = {
  host: PROTEINPAINT_API,
  localFingerprint: pageLocalFingerprint,
  loadCitedCall: citedCallLoader(httpRoutes()),
  mountTimeoutMs: MOUNT_TIMEOUT_MS,
};

export const VizServicesContext = createContext<VizServices>(DEFAULT_VIZ_SERVICES);
