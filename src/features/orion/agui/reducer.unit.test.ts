import {
  createThread,
  isInvocationActive,
  threadReducer,
  type ThreadAction,
  type ThreadState,
} from './reducer';
import {
  REJECTION_CODES,
  type AguiEvent,
  type FinishedStatus,
  type OrionCode,
  type RunView,
  type StateSnapshotEvent,
  type Step,
} from './types';
import { fixtureEvents } from '../testing';

const EVENTS = fixtureEvents();
const SNAPSHOTS = EVENTS.filter((e): e is StateSnapshotEvent => e.type === 'STATE_SNAPSHOT');
const FINAL = SNAPSHOTS[SNAPSHOTS.length - 1].snapshot;
const THREAD = FINAL.threadId;
const RUN = FINAL.runId;

const reduce = (actions: ThreadAction[], state: ThreadState = createThread(THREAD)) =>
  actions.reduce(threadReducer, state);

const submit = (runId = RUN, question = FINAL.question): ThreadAction => ({
  type: 'submit',
  runId,
  question,
  at: '2026-11-04T15:00:00.000Z',
});

const snapshot = (revision: number, patch: Partial<RunView> = {}): StateSnapshotEvent => {
  const base = SNAPSHOTS.find((e) => e.snapshot.revision === revision) ?? SNAPSHOTS[0];
  return { type: 'STATE_SNAPSHOT', snapshot: { ...base.snapshot, ...patch } };
};

const started = (runId = RUN): AguiEvent => ({ type: 'RUN_STARTED', threadId: THREAD, runId });
const runError: AguiEvent = { type: 'RUN_ERROR', message: 'boom', code: 'INTERNAL_ERROR' };
const finished = (status: FinishedStatus, runId = RUN, code: OrionCode | null = null): AguiEvent => ({
  type: 'RUN_FINISHED',
  threadId: THREAD,
  runId,
  result: { status, code },
});

/** What the next turn reports for a run whose lease expired after the given revision. */
const interrupted = (runId: string, after: number): StateSnapshotEvent => {
  const { snapshot: view } = snapshot(after, { runId });
  const steps = view.steps.map((s): Step => {
    if (s.status === 'Running') return { ...s, status: 'Failed' };
    return s.status === 'Queued' ? { ...s, status: 'Skipped' } : s;
  });
  return {
    type: 'STATE_SNAPSHOT',
    snapshot: { ...view, revision: after + 1, status: 'Interrupted', code: 'RUN_INTERRUPTED', steps },
  };
};

describe('threadReducer', () => {
  it('replays the J1 fixture to ObservedOnly with every step as the fixture ends it', () => {
    const state = reduce([submit(), ...EVENTS]);
    const run = state.runs[RUN];
    expect(run.status).toBe('ObservedOnly');
    expect(run.view?.revision).toBe(9);
    expect(run.view?.steps.map((s) => [s.id, s.status])).toEqual(
      FINAL.steps.map((s) => [s.id, s.status]),
    );
    expect(run.view?.steps.every((s) => s.status === 'Done' || s.status === 'Skipped')).toBe(true);
    expect(run.lastHeartbeatAt).toBe('2026-11-04T15:00:05.300Z');
    expect(run.flags).toEqual([]);
    expect(state.flags).toEqual([]);
    expect(state.invocation).toEqual({ runId: RUN, kind: 'ask', terminal: true, closed: false });
    expect(isInvocationActive(state)).toBe(false);
  });

  it('creates the run from RUN_STARTED when no submit preceded it', () => {
    const state = reduce(EVENTS);
    expect(state.runIds).toEqual([RUN]);
    expect(state.runs[RUN].status).toBe('ObservedOnly');
    expect(state.runs[RUN].question).toBe(FINAL.question);
  });

  it('keeps the highest revision and ignores stale or repeated snapshots', () => {
    const state = reduce([submit(), started(), snapshot(4), snapshot(3), snapshot(4, { status: 'Failed' })]);
    expect(state.runs[RUN].view?.revision).toBe(4);
    expect(state.runs[RUN].status).toBe('Executing');
    expect(state.runs[RUN].view?.steps.find((s) => s.id === 's2')?.status).toBe('Running');
  });

  it('starts a waiting step on STEP_STARTED and leaves each outcome to the snapshot', () => {
    const between = reduce([
      submit(),
      started(),
      snapshot(3),
      { type: 'STEP_FINISHED', stepName: 's1' },
      { type: 'STEP_STARTED', stepName: 's2' },
    ]);
    const steps = between.runs[RUN].view?.steps ?? [];
    expect(steps.find((s) => s.id === 's1')?.status).toBe('Running');
    expect(steps.find((s) => s.id === 's2')?.status).toBe('Running');
    expect(between.runs[RUN].view?.revision).toBe(3);

    const empty = snapshot(4, {
      steps: snapshot(4).snapshot.steps.map((s) => (s.id === 's1' ? { ...s, status: 'Empty' } : s)),
    });
    const after = reduce([empty, { type: 'STEP_STARTED', stepName: 's1' }], between);
    expect(after.runs[RUN].view?.steps.find((s) => s.id === 's1')?.status).toBe('Empty');
  });

  it('never shows a step Done that no snapshot confirmed, even when the run fails first', () => {
    const state = reduce([
      submit(),
      started(),
      snapshot(4),
      { type: 'STEP_FINISHED', stepName: 's2' },
      runError,
    ]);
    expect(state.runs[RUN].status).toBe('Failed');
    expect(state.runs[RUN].view?.steps.map((s) => s.status)).toEqual(
      snapshot(4).snapshot.steps.map((s) => s.status),
    );
  });

  it('flags a step event for a step the view does not know', () => {
    const state = reduce([submit(), started(), snapshot(2), { type: 'STEP_STARTED', stepName: 's99' }]);
    expect(state.runs[RUN].flags).toEqual(['UNKNOWN_STEP']);
  });

  it('attributes RUN_ERROR to the open run and ends it Failed with its code', () => {
    const older = 'a'.repeat(32);
    const state = reduce([
      submit(older, 'first'),
      started(older),
      finished('Complete', older),
      submit(RUN, 'second'),
      started(),
      snapshot(2),
      runError,
    ]);
    expect(state.runs[older].status).toBe('Complete');
    expect(state.runs[RUN]).toMatchObject({
      status: 'Failed',
      code: 'INTERNAL_ERROR',
      errorMessage: 'boom',
    });
    expect(isInvocationActive(state)).toBe(false);
  });

  it('takes back the submitted run when a lone RUN_ERROR rejects its ids', () => {
    const older = 'a'.repeat(32);
    const state = reduce([
      submit(older, 'first'),
      started(older),
      finished('Complete', older),
      submit(RUN, 'second'),
      { type: 'RUN_ERROR', message: 'bad ids', code: 'INVALID_INPUT' },
    ]);
    expect(state.runIds).toEqual([older]);
    expect(state.runs[RUN]).toBeUndefined();
    expect(state.runs[older].status).toBe('Complete');
    expect(state.notice).toEqual({
      code: 'INVALID_INPUT',
      message: 'bad ids',
      turn: 'ask',
      question: 'second',
    });
    expect(isInvocationActive(state)).toBe(false);
  });

  it.each(REJECTION_CODES)('never shows an ask rejected with %s as a Failed run', (code) => {
    const state = reduce([submit(), started(), { type: 'RUN_ERROR', message: 'no', code }]);
    expect(state.runIds).toEqual([]);
    expect(state.notice).toMatchObject({ code, turn: 'ask', question: FINAL.question });
    expect(state.flags).toEqual([]);
    expect(isInvocationActive(state)).toBe(false);
  });

  it('leaves a run as it was when its Stop is rejected', () => {
    const state = reduce([
      submit(),
      started(),
      snapshot(4),
      { type: 'stop', runId: RUN },
      started(),
      { type: 'RUN_ERROR', message: 'busy', code: 'RUN_BUSY' },
    ]);
    expect(state.runs[RUN]).toMatchObject({
      status: 'Executing',
      code: null,
      errorMessage: null,
      stopRequested: false,
    });
    expect(state.runs[RUN].view?.revision).toBe(4);
    expect(state.notice).toEqual({ code: 'RUN_BUSY', message: 'busy', turn: 'cancel', question: null });
    expect(isInvocationActive(state)).toBe(false);
  });

  it('takes back a run whose Stop came before any snapshot and found no such run', () => {
    const stopped = reduce([submit(), { type: 'stop', runId: RUN }, started()]);
    const state = reduce([{ type: 'RUN_ERROR', message: 'gone', code: 'RUN_NOT_FOUND' }], stopped);
    expect(state.runIds).toEqual([]);
    expect(state.runs[RUN]).toBeUndefined();
    expect(state.notice).toEqual({
      code: 'RUN_NOT_FOUND',
      message: 'gone',
      turn: 'cancel',
      question: FINAL.question,
    });
    expect(state.flags).toEqual([]);
    expect(isInvocationActive(state)).toBe(false);

    // Any other rejection leaves the run: the agent may still have it.
    const busy = reduce([{ type: 'RUN_ERROR', message: 'busy', code: 'RUN_BUSY' }], stopped);
    expect(busy.runs[RUN]).toMatchObject({ status: 'Planning', stopRequested: false });
    expect(busy.notice?.question).toBeNull();
  });

  it('clears the notice when the browser sends the next turn', () => {
    const rejected = reduce([submit(), { type: 'RUN_ERROR', message: 'busy', code: 'RUN_BUSY' }]);
    expect(rejected.notice?.code).toBe('RUN_BUSY');
    const next = 'c'.repeat(32);
    const asked = reduce([submit(next, 'again')], rejected);
    expect(asked.notice).toBeNull();
    expect(asked.runIds).toEqual([next]);
  });

  it("files an earlier run's Interrupted snapshot under that run while the ask goes on", () => {
    const older = 'a'.repeat(32);
    const lost = reduce([
      submit(older, 'first'),
      started(older),
      snapshot(5, { runId: older }),
      { type: 'transportError', runId: older, code: 'NETWORK', message: 'reset' },
    ]);
    const state = reduce([submit(), started(), interrupted(older, 5), snapshot(2), snapshot(3)], lost);
    expect(state.runIds).toEqual([older, RUN]);
    expect(state.runs[older]).toMatchObject({ status: 'Interrupted', code: 'RUN_INTERRUPTED' });
    expect(state.runs[older].view?.steps.map((s) => s.status)).toEqual([
      'Done',
      'Done',
      'Failed',
      'Skipped',
      'Skipped',
    ]);
    expect(state.runs[RUN].status).toBe('Executing');
    expect(state.runs[RUN].view?.revision).toBe(3);
    expect(state.invocation).toEqual({ runId: RUN, kind: 'ask', terminal: false, closed: false });
    expect(state.flags).toEqual([]);
  });

  it('ends a stopped run Interrupted when its lease had expired, keeping the finished rows', () => {
    const state = reduce([
      submit(),
      started(),
      snapshot(5),
      { type: 'stop', runId: RUN },
      started(),
      interrupted(RUN, 5),
      finished('Interrupted', RUN, 'RUN_INTERRUPTED'),
    ]);
    expect(state.runs[RUN]).toMatchObject({ status: 'Interrupted', code: 'RUN_INTERRUPTED' });
    expect(state.runs[RUN].view?.steps.filter((s) => s.status === 'Done').map((s) => s.id)).toEqual([
      's1',
      's2',
    ]);
    expect(state.runs[RUN].flags).toEqual([]);
    expect(isInvocationActive(state)).toBe(false);
  });

  it('flags a RUN_ERROR when no run is open', () => {
    const state = reduce([runError]);
    expect(state.runIds).toEqual([]);
    expect(state.flags).toEqual(['ORPHAN_EVENT']);
  });

  it('ignores and flags a second terminal event in one invocation', () => {
    const state = reduce([submit(), ...EVENTS, runError, finished('Complete')]);
    expect(state.runs[RUN].status).toBe('ObservedOnly');
    expect(state.runs[RUN].code).toBeNull();
    expect(state.runs[RUN].flags).toEqual(['DOUBLE_TERMINAL']);
  });

  it('treats a resumed turn as a new invocation, not a second terminal', () => {
    const state = reduce([
      submit(),
      started(),
      finished('AwaitingConfirmation'),
      started(),
      finished('Complete'),
    ]);
    expect(state.runs[RUN].status).toBe('Complete');
    expect(state.runs[RUN].flags).toEqual([]);
  });

  it('keeps the terminal status when a late snapshot of the same invocation arrives', () => {
    const state = reduce([submit(), started(), snapshot(2), runError, snapshot(3)]);
    expect(state.runs[RUN].status).toBe('Failed');
    expect(state.runs[RUN].view?.revision).toBe(3);
  });

  it('records heartbeats on the open run', () => {
    const state = reduce([
      submit(),
      started(),
      { type: 'CUSTOM', name: 'orion.heartbeat', value: { ts: '2026-11-04T15:00:20.000Z' } },
    ]);
    expect(state.runs[RUN].lastHeartbeatAt).toBe('2026-11-04T15:00:20.000Z');
  });

  it('shows Stopping at once and ends Stopped by you when the cancel turn finishes', () => {
    const stopping = reduce([submit(), started(), snapshot(4), { type: 'stop', runId: RUN }]);
    expect(stopping.runs[RUN].status).toBe('Stopping');
    expect(isInvocationActive(stopping)).toBe(true);
    const later = reduce([started(), snapshot(5), finished('Cancelled')], stopping);
    expect(later.runs[RUN].status).toBe('Cancelled');
  });

  it('ends a withdrawn ask Stopped by you with no turn left open', () => {
    const state = reduce([submit(), { type: 'withdraw', runId: RUN }]);
    expect(state.runs[RUN]).toMatchObject({ status: 'Cancelled', stopRequested: true });
    expect(isInvocationActive(state)).toBe(false);
    expect(reduce([runError], state).flags).toEqual(['ORPHAN_EVENT']);

    const ended = reduce([submit(), ...EVENTS]);
    expect(reduce([{ type: 'withdraw', runId: RUN }], ended)).toBe(ended);
  });

  it('fails a run whose turn never started and closes a started one on a transport error', () => {
    const neverStarted = reduce([
      submit(),
      { type: 'transportError', runId: RUN, code: 'NOT_EVENT_STREAM', message: 'HTTP 400' },
    ]);
    expect(neverStarted.runs[RUN].status).toBe('Failed');
    expect(isInvocationActive(neverStarted)).toBe(false);

    const lost = reduce([
      submit(),
      started(),
      snapshot(3),
      { type: 'transportError', runId: RUN, code: 'NETWORK', message: 'reset' },
    ]);
    expect(lost.runs[RUN].status).toBe('Executing');
    expect(lost.runs[RUN].transportError).toEqual({ code: 'NETWORK', message: 'reset' });
    expect(isInvocationActive(lost)).toBe(false);
  });

  it('accumulates save_cohorts tool-call arguments', () => {
    const state = reduce([
      submit(),
      started(),
      { type: 'TOOL_CALL_START', toolCallId: 'c1', toolCallName: 'save_cohorts' },
      { type: 'TOOL_CALL_ARGS', toolCallId: 'c1', delta: '{"cohorts":' },
      { type: 'TOOL_CALL_ARGS', toolCallId: 'c1', delta: '[]}' },
      { type: 'TOOL_CALL_END', toolCallId: 'c1' },
    ]);
    expect(state.runs[RUN].toolCalls).toEqual([
      { id: 'c1', name: 'save_cohorts', args: '{"cohorts":[]}', ended: true },
    ]);
  });

  it('ignores and flags snapshots from another thread', () => {
    const foreign = reduce([snapshot(2, { threadId: 'c'.repeat(32) })]);
    expect(foreign.runIds).toEqual([]);
    expect(foreign.flags).toEqual(['FOREIGN_THREAD']);
  });
});
