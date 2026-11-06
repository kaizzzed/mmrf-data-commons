/** @jest-environment node */
import type { RunRecord, RunView } from '../agui/types';
import {
  applyLeaseRule,
  INTERRUPTED_WITHHELD,
  isLeaseLapsed,
  leaseExpired,
  RUN_INTERRUPTED_LIMITATION,
  STOPPED_SUMMARY,
  type LeaseRecord,
} from './leaseRule';
import { parseFrames, readFixture } from './testHarness';

const snapshots = (fixture: string): RunView[] =>
  parseFrames(readFixture(fixture))
    .filter((frame) => frame.type === 'STATE_SNAPSHOT')
    .map((frame) => frame.snapshot as RunView);

const j1Record = (): RunRecord => JSON.parse(readFixture('run-record.j1-complete.json').toString('utf8')) as RunRecord;

/** The stored J1 record as it stood at an earlier transition: that snapshot as its runView. */
const recordAt = (view: RunView, lease: RunRecord['lease']): LeaseRecord => ({
  ...j1Record(),
  status: view.status,
  revision: view.revision,
  updatedAt: view.updatedAt,
  lease,
  runView: view,
});

const lease = (expiresAt: string) => ({ owner: 'agent-1', renewedAt: expiresAt, expiresAt });

describe('the expired-lease rule', () => {
  const j1 = snapshots('j1-complete.events.jsonl');
  const executingAtS4 = j1.find((view) => view.revision === 6) as RunView;
  // interrupted.events.jsonl: the same J1 run stopped responding at s4, as the agent records it.
  const interrupted = snapshots('interrupted.events.jsonl')[0];

  it('ends an Executing run Interrupted exactly as the agent records it (interrupted fixture)', () => {
    expect(executingAtS4.status).toBe('Executing');
    const view = { ...executingAtS4, threadId: interrupted.threadId, runId: interrupted.runId };
    const record = recordAt(view, lease(interrupted.updatedAt));
    const now = Date.parse(interrupted.updatedAt) + 1;
    expect(applyLeaseRule(record, now)).toEqual(interrupted);
    expect(JSON.stringify(applyLeaseRule(record, now))).toBe(JSON.stringify(interrupted));
  });

  it('treats a lease expiring exactly now as expired, and a later one as live', () => {
    const record = recordAt(executingAtS4, lease('2026-11-04T15:03:04.200Z'));
    const expiry = Date.parse('2026-11-04T15:03:04.200Z');
    expect(applyLeaseRule(record, expiry).status).toBe('Interrupted');
    expect(applyLeaseRule(record, expiry - 1)).toBe(executingAtS4);
  });

  it('ends a Stopping run Cancelled: open steps Skipped "Not run: stopped", code null', () => {
    const stopping = snapshots('j1-stop.events.jsonl')[0];
    expect(stopping.status).toBe('Stopping');
    const record = recordAt(stopping, lease('2026-11-04T15:00:39.000Z'));
    const view = applyLeaseRule(record, Date.parse('2026-11-04T15:01:00Z'));
    expect(view).toEqual({
      ...stopping,
      revision: stopping.revision + 1,
      status: 'Cancelled',
      code: null,
      updatedAt: '2026-11-04T15:00:39.000Z',
      steps: stopping.steps.map((step) =>
        ['Running', 'Queued'].includes(step.status) ? { ...step, status: 'Skipped', outputSummary: STOPPED_SUMMARY } : step,
      ),
      pending: null,
    });
    // No Observed yet, so nothing is withheld; no limitation is added for a stop.
    expect(view.withheldReason).toBeNull();
    expect(view.limitations).toEqual(stopping.limitations);
  });

  it('withholds the interpretation when an Answering run with Observed is interrupted', () => {
    const answering = j1.find((view) => view.status === 'Answering') as RunView;
    expect(answering.observed.length).toBeGreaterThan(0);
    const view = applyLeaseRule(recordAt(answering, null), Date.now());
    expect(view.status).toBe('Interrupted');
    expect(view.withheldReason).toBe(INTERRUPTED_WITHHELD);
    expect(view.steps).toEqual(answering.steps);
    expect(view.limitations.at(-1)).toEqual(RUN_INTERRUPTED_LIMITATION);
  });

  it('withholds "you stopped the run" for a Stopping run that has Observed', () => {
    const answering = j1.find((view) => view.status === 'Answering') as RunView;
    const stopping: RunView = { ...answering, status: 'Stopping' };
    const view = applyLeaseRule(recordAt(stopping, null), Date.now());
    expect(view.status).toBe('Cancelled');
    expect(view.withheldReason).toBe('you stopped the run');
  });

  it("takes updatedAt from the record when there is no lease, and keeps a withheld reason it already has", () => {
    const record = { ...recordAt({ ...executingAtS4, withheldReason: 'a step failed' }, null), updatedAt: '2026-11-04T15:00:06.000Z' };
    const view = applyLeaseRule(record, Date.now());
    expect(view.updatedAt).toBe('2026-11-04T15:00:06.000Z');
    expect(view.revision).toBe(record.revision + 1);
    expect(view.withheldReason).toBe('a step failed');
  });

  it('fails Retrying steps like Running ones and leaves finished steps alone', () => {
    const steps = executingAtS4.steps.map((step) => (step.id === 's4' ? { ...step, status: 'Retrying' as const } : step));
    const view = applyLeaseRule(recordAt({ ...executingAtS4, steps }, null), Date.now());
    expect(view.steps.map((step) => [step.id, step.status, step.code])).toEqual([
      ['s1', 'Done', null],
      ['s2', 'Done', null],
      ['s3', 'Done', null],
      ['s4', 'Failed', 'RUN_INTERRUPTED'],
      ['s5', 'Skipped', null],
    ]);
  });

  it('never rewrites a record outside the leased statuses, whatever its lease', () => {
    const complete = j1Record();
    expect(complete.status).toBe('Complete');
    const record = { ...complete, runView: complete.runView as RunView };
    expect(applyLeaseRule(record, Date.now())).toBe(record.runView);
    for (const status of ['AwaitingConfirmation', 'Clarifying', 'Partial', 'Cancelled', 'Interrupted'] as const) {
      expect(isLeaseLapsed({ status, lease: null }, Date.now())).toBe(false);
    }
  });

  it('counts a missing or unreadable lease as expired', () => {
    expect(leaseExpired(null, 0)).toBe(true);
    expect(leaseExpired({ expiresAt: 'not a time' }, 0)).toBe(true);
    expect(leaseExpired({ expiresAt: '2099-01-01T00:00:00.000Z' }, Date.now())).toBe(false);
  });
});
