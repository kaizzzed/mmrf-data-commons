// The expired-lease rule (contract "Invocation outcomes", Expired leases, and the view route):
// a record in a leased status whose lease is missing or lapsed is shown as the controller will
// record it on the next turn (controller.py `_expire`, `_cancel_mark`). Pure; server and tests.

import {
  LEASED_STATUSES,
  type Lease,
  type Limitation,
  type RunStatus,
  type RunView,
  type Step,
  type StepStatus,
} from '../agui/types';

// The controller's words (orion_agent/controller.py).
export const STOPPED_SUMMARY = 'Not run: stopped';
export const INTERRUPTED_SUMMARY = 'Not run: interrupted';
export const STOPPED_WITHHELD = 'you stopped the run';
export const INTERRUPTED_WITHHELD = 'the run was interrupted';

export const RUN_INTERRUPTED_LIMITATION: Limitation = {
  code: 'RUN_INTERRUPTED',
  text: 'The run stopped responding before it finished; completed steps are shown as partial.',
  unblock: 'Ask again.',
  nearestApps: [],
};

/** The record fields the rule reads. */
export interface LeaseRecord {
  status: RunStatus;
  revision: number;
  updatedAt: string;
  lease: Pick<Lease, 'expiresAt'> | null;
  runView: RunView;
}

const LEASED: ReadonlySet<RunStatus> = new Set(LEASED_STATUSES);
const STOP_SKIPPED: ReadonlySet<StepStatus> = new Set(['Queued', 'AwaitingUser', 'Running', 'Retrying']);

/** A missing or unreadable lease counts as expired: an active status without one has no live controller. */
export const leaseExpired = (lease: Pick<Lease, 'expiresAt'> | null, now: number): boolean => {
  if (lease === null) return true;
  const expires = Date.parse(lease.expiresAt);
  return Number.isNaN(expires) || expires <= now;
};

export const isLeaseLapsed = (record: Pick<LeaseRecord, 'status' | 'lease'>, now: number): boolean =>
  LEASED.has(record.status) && leaseExpired(record.lease, now);

/** The agent writes `iso_utc` (milliseconds, `Z`); a parsable time is normalized the same way. */
const isoUtc = (value: string): string => {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? value : new Date(ms).toISOString();
};

/**
 * The view the route serves: the record's runView, rewritten when the lease lapsed. Stopping
 * ends Cancelled (`code` null); every other leased status ends Interrupted (`RUN_INTERRUPTED`).
 * Revision + 1, `updatedAt` the lease's expiry (or the record's updatedAt without a lease),
 * `pending` null. Nothing else changes.
 */
export const applyLeaseRule = (record: LeaseRecord, now: number): RunView => {
  const view = record.runView;
  if (!isLeaseLapsed(record, now)) return view;
  const updatedAt = isoUtc(record.lease ? record.lease.expiresAt : record.updatedAt);
  const revision = record.revision + 1;
  const hasObserved = view.observed.length > 0;
  if (record.status === 'Stopping') {
    return {
      ...view,
      revision,
      status: 'Cancelled',
      code: null,
      updatedAt,
      steps: view.steps.map((step): Step =>
        STOP_SKIPPED.has(step.status) ? { ...step, status: 'Skipped', outputSummary: STOPPED_SUMMARY } : step,
      ),
      withheldReason: hasObserved && view.withheldReason === null ? STOPPED_WITHHELD : view.withheldReason,
      pending: null,
    };
  }
  return {
    ...view,
    revision,
    status: 'Interrupted',
    code: 'RUN_INTERRUPTED',
    updatedAt,
    steps: view.steps.map((step): Step => {
      if (step.status === 'Running' || step.status === 'Retrying') {
        return { ...step, status: 'Failed', code: 'RUN_INTERRUPTED' };
      }
      if (step.status === 'Queued') return { ...step, status: 'Skipped', outputSummary: INTERRUPTED_SUMMARY };
      return step;
    }),
    limitations: [...view.limitations, { ...RUN_INTERRUPTED_LIMITATION, nearestApps: [] }],
    withheldReason: hasObserved && view.withheldReason === null ? INTERRUPTED_WITHHELD : view.withheldReason,
    pending: null,
  };
};
