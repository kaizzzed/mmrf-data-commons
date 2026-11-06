import { activeRunId, type ThreadAction } from '../agui/reducer';
import type { ParseResult } from '../agui/sseParser';
import { TransportError, type RunRoutes, type RunTransport } from '../agui/transport';
import type { AguiEvent, CohortContext, RunAgentInput, RunView, VizReport } from '../agui/types';
import { dontSaveAction } from '../cohort/saveCohorts';
import { createTab, tabReducer, threadInFlight, type TabAction, type TabState } from '../state/tab';
import { replayStream, streamViews } from '../testing';
import {
  BUSY_POLL_LIMIT_MS,
  BUSY_POLL_MS,
  createRunController,
  FOLLOW_LIMIT_MS,
  FOLLOW_POLL_MS,
  QUEUE_WAIT_MS,
  VIZ_REPORT_IDLE_MS,
  type RunController,
} from './runController';

const THREAD = '0123456789abcdef0123456789abcdef';
const OTHER_THREAD = '89abcdef0123456789abcdef01234567';
const RUN = 'fedcba9876543210fedcba9876543210';
const COHORT: CohortContext = {
  active: { id: null, name: 'All cases', filters: { mode: 'and', root: {} }, caseCount: 1000 },
  saved: [],
};

const J3_PAUSE = streamViews('j3-save-pause').pop() as RunView;
const J1_DONE = streamViews('j1-complete').pop() as RunView;
const J1_EXECUTING = streamViews('j1-complete')[3];

type Reply = AguiEvent[] | TransportError | 'hang';

const ok = (input: RunAgentInput, status: 'Complete' | 'Recorded' = 'Complete'): AguiEvent[] => [
  { type: 'RUN_STARTED', threadId: input.threadId, runId: input.runId },
  { type: 'RUN_FINISHED', threadId: input.threadId, runId: input.runId, result: { status, code: null } },
];

const bff = (code: 'SESSION_BUSY' | 'UPSTREAM_TIMEOUT' | 'UPSTREAM_UNAVAILABLE' | 'UPSTREAM_ERROR', status: number) =>
  new TransportError('BFF_ERROR', `the BFF said ${code}`, status, code);

const notStored = () => new TransportError('BFF_ERROR', 'no such run', 404, 'RUN_NOT_FOUND');

/** A transport that answers each turn from `reply`, and view routes that answer from `views`. */
const scripted = (reply: (input: RunAgentInput) => Reply, views: (RunView | TransportError)[] = []) => {
  const turns: RunAgentInput[] = [];
  const routes: RunRoutes & { view: jest.Mock } = {
    view: jest.fn(async () => {
      const next = views.length > 1 ? views.shift() : views[0];
      if (!next) throw notStored();
      if (next instanceof TransportError) throw next;
      return next;
    }),
    record: jest.fn(async () => {
      throw notStored();
    }),
    recordDownloadHref: () => '/record',
  };
  const transport: RunTransport = {
    routes,
    async *run(input, signal): AsyncGenerator<ParseResult> {
      turns.push(input);
      const answer = reply(input);
      if (answer instanceof TransportError) throw answer;
      if (answer === 'hang') {
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
        throw new TransportError('ABORTED', 'stopped');
      }
      for (const event of answer) yield { kind: 'event', event };
    },
  };
  return { transport, turns, routes };
};

const setup = (reply: (input: RunAgentInput) => Reply, views: (RunView | TransportError)[] = []) => {
  const script = scripted(reply, views);
  const dispatch = jest.fn<void, [TabAction]>();
  const controller: RunController = createRunController(script.transport, dispatch);
  const threadActions = (): ThreadAction[] =>
    dispatch.mock.calls.flatMap(([action]) => (action.type === 'thread' ? [action.action] : []));
  const types = () => threadActions().map((a) => a.type);
  return { ...script, dispatch, controller, threadActions, types };
};

const actionsOf = (turns: RunAgentInput[]) => turns.map((t) => t.forwardedProps.orion.action);

const report = (vizId: string, runId = RUN): VizReport => ({ runId, vizId, mounted: true, error: null, pinnedHashVerified: true });

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe('createRunController: viz reports', () => {
  it('lets queued reports ride on the next turn, at most 8, the rest on the turn after', async () => {
    const { controller, turns } = setup((input) => ok(input));
    for (let i = 1; i <= 9; i++) controller.reportViz(THREAD, report(`v${i}`));
    controller.ask(THREAD, 'first', COHORT);
    await jest.advanceTimersByTimeAsync(0);
    expect(turns[0].forwardedProps.orion.vizReports?.map((r) => r.vizId)).toEqual(['v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7', 'v8']);
    controller.ask(THREAD, 'second', COHORT);
    await jest.advanceTimersByTimeAsync(0);
    expect(turns[1].forwardedProps.orion.vizReports?.map((r) => r.vizId)).toEqual(['v9']);
    controller.ask(THREAD, 'third', COHORT);
    await jest.advanceTimersByTimeAsync(0);
    expect(turns[2].forwardedProps.orion.vizReports).toBeUndefined();
  });

  it('keeps only the latest report of a viz', async () => {
    const { controller, turns } = setup((input) => ok(input));
    controller.reportViz(THREAD, { ...report('v1'), mounted: false, error: 'first try' });
    controller.reportViz(THREAD, report('v1'));
    controller.ask(THREAD, 'q', COHORT);
    await jest.advanceTimersByTimeAsync(0);
    expect(turns[0].forwardedProps.orion.vizReports).toEqual([report('v1')]);
  });

  it('sends each report standalone 2 s after the last one when no turn is open, outside the reducer', async () => {
    const { controller, turns, dispatch } = setup((input) => ok(input, 'Recorded'));
    controller.reportViz(THREAD, report('v1'));
    await jest.advanceTimersByTimeAsync(VIZ_REPORT_IDLE_MS - 500);
    controller.reportViz(THREAD, report('v2', 'b'.repeat(32)));
    await jest.advanceTimersByTimeAsync(VIZ_REPORT_IDLE_MS - 1);
    expect(turns).toEqual([]);
    await jest.advanceTimersByTimeAsync(1);
    expect(turns.map((t) => [t.runId, t.forwardedProps.orion])).toEqual([
      [RUN, { action: 'viz_report', vizId: 'v1', mounted: true, error: null, pinnedHashVerified: true }],
      ['b'.repeat(32), { action: 'viz_report', vizId: 'v2', mounted: true, error: null, pinnedHashVerified: true }],
    ]);
    expect(turns.every((t) => t.messages.length === 0)).toBe(true);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('holds reports back while an invocation is open when the 2 s pass', async () => {
    const { controller, turns } = setup((input) => (input.forwardedProps.orion.action === 'ask' ? 'hang' : ok(input)));
    controller.ask(THREAD, 'q', COHORT);
    await jest.advanceTimersByTimeAsync(0);
    controller.reportViz(THREAD, report('v1'));
    await jest.advanceTimersByTimeAsync(VIZ_REPORT_IDLE_MS + 10);
    expect(actionsOf(turns)).toEqual(['ask']);
    controller.stop(THREAD, RUN);
    await jest.advanceTimersByTimeAsync(0);
    expect(actionsOf(turns)).toEqual(['ask', 'cancel']);
    expect(turns[1].forwardedProps.orion.vizReports).toEqual([report('v1')]);
  });

  it('starts the 2 s timer again when the open invocation ends with reports still queued', async () => {
    let finish: () => void = () => undefined;
    const ended = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const turns: RunAgentInput[] = [];
    const transport: RunTransport = {
      async *run(input): AsyncGenerator<ParseResult> {
        turns.push(input);
        yield { kind: 'event', event: { type: 'RUN_STARTED', threadId: input.threadId, runId: input.runId } };
        if (input.forwardedProps.orion.action === 'ask') await ended;
        const status = input.forwardedProps.orion.action === 'ask' ? 'Complete' : 'Recorded';
        yield { kind: 'event', event: { type: 'RUN_FINISHED', threadId: input.threadId, runId: input.runId, result: { status, code: null } } };
      },
    };
    const controller = createRunController(transport, jest.fn());
    controller.ask(THREAD, 'q', COHORT);
    await jest.advanceTimersByTimeAsync(0);
    controller.reportViz(THREAD, report('v1'));
    await jest.advanceTimersByTimeAsync(VIZ_REPORT_IDLE_MS + 10);
    // The ask was open when the 2 s passed: the report waits.
    expect(actionsOf(turns)).toEqual(['ask']);
    finish();
    await jest.advanceTimersByTimeAsync(VIZ_REPORT_IDLE_MS - 1);
    expect(actionsOf(turns)).toEqual(['ask']);
    await jest.advanceTimersByTimeAsync(1);
    // No turn came, so it went on its own instead of waiting for one.
    expect(turns.map((t) => [t.runId, t.forwardedProps.orion])).toEqual([
      [turns[0].runId, turns[0].forwardedProps.orion],
      [RUN, { action: 'viz_report', vizId: 'v1', mounted: true, error: null, pinnedHashVerified: true }],
    ]);
  });

  it('keeps a standalone report that failed for the next turn, without retrying it every 2 s', async () => {
    let fail = true;
    const { controller, turns } = setup((input) => {
      if (input.forwardedProps.orion.action === 'viz_report' && fail) {
        fail = false;
        return new TransportError('NETWORK', 'offline');
      }
      return ok(input);
    });
    controller.reportViz(THREAD, report('v1'));
    await jest.advanceTimersByTimeAsync(VIZ_REPORT_IDLE_MS);
    expect(actionsOf(turns)).toEqual(['viz_report']);
    await jest.advanceTimersByTimeAsync(VIZ_REPORT_IDLE_MS * 5);
    expect(actionsOf(turns)).toEqual(['viz_report']);
    controller.ask(THREAD, 'q', COHORT);
    await jest.advanceTimersByTimeAsync(0);
    expect(turns[1].forwardedProps.orion.vizReports).toEqual([report('v1')]);
  });

  it('queues the reports of a rejected turn again for the next one', async () => {
    let first = true;
    const { controller, turns } = setup((input) => {
      if (!first) return ok(input);
      first = false;
      return [
        { type: 'RUN_STARTED', threadId: input.threadId, runId: input.runId },
        { type: 'RUN_ERROR', code: 'RUN_BUSY', message: 'busy' },
      ];
    });
    controller.reportViz(THREAD, report('v1'));
    controller.ask(THREAD, 'q', COHORT);
    await jest.advanceTimersByTimeAsync(0);
    controller.ask(THREAD, 'q again', COHORT);
    await jest.advanceTimersByTimeAsync(0);
    expect(turns.map((t) => t.forwardedProps.orion.vizReports)).toEqual([[report('v1')], [report('v1')]]);
  });
});

describe('createRunController: BFF errors', () => {
  it('rejects an ask the BFF answers UPSTREAM_UNAVAILABLE, as a rejected turn', async () => {
    const { controller, threadActions, types } = setup(() => bff('UPSTREAM_UNAVAILABLE', 503));
    const runId = controller.ask(THREAD, 'q', COHORT);
    await jest.advanceTimersByTimeAsync(0);
    expect(types()).toEqual(['submit', 'turn', 'turnRejected']);
    expect(threadActions()[2]).toEqual({ type: 'turnRejected', runId, code: 'UPSTREAM_UNAVAILABLE', message: 'the BFF said UPSTREAM_UNAVAILABLE' });
  });

  it('SESSION_BUSY on a resume: polls the view while the run is leased, then resends the turn unchanged', async () => {
    let calls = 0;
    const paused = { ...J3_PAUSE, runId: RUN, threadId: THREAD };
    const leased = { ...paused, status: 'Executing' as const, pending: null };
    const { controller, turns, routes, types } = setup(
      (input) => (++calls === 1 ? bff('SESSION_BUSY', 409) : ok(input)),
      [leased, paused],
    );
    const nonce = paused.pending?.kind === 'confirm' ? paused.pending.nonce : '';
    const confirm = { action: 'confirm' as const, nonce, decision: 'dont_save' as const, saved: [], makeActive: null };
    controller.resume(THREAD, RUN, confirm, { status: 'AwaitingConfirmation', nonce });
    await jest.advanceTimersByTimeAsync(0);
    expect(turns).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(BUSY_POLL_MS);
    expect(routes.view).toHaveBeenCalledTimes(1);
    expect(turns).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(BUSY_POLL_MS);
    expect(routes.view).toHaveBeenCalledTimes(2);
    expect(turns).toHaveLength(2);
    expect(turns[1]).toEqual(turns[0]);
    expect(types().filter((t) => t === 'view')).toHaveLength(2);
    expect(types().at(-1)).toBe('RUN_FINISHED');
  });

  it('SESSION_BUSY on a resume that no longer applies: shows the run as the view has it, sends nothing', async () => {
    const moved = { ...J1_DONE, runId: RUN, threadId: THREAD };
    const { controller, turns, threadActions } = setup(() => bff('SESSION_BUSY', 409), [moved]);
    controller.resume(THREAD, RUN, { action: 'retry_step', stepId: 's4' }, { status: 'Partial', nonce: null });
    await jest.advanceTimersByTimeAsync(BUSY_POLL_MS);
    expect(turns).toHaveLength(1);
    expect(threadActions().slice(-2)).toEqual([{ type: 'view', view: moved }, { type: 'turnSettled', runId: RUN }]);
  });

  it('SESSION_BUSY on an ask: a 404 view means it never started, so it goes again under the same runId', async () => {
    let calls = 0;
    const { controller, turns } = setup((input) => (++calls === 1 ? bff('SESSION_BUSY', 409) : ok(input)), [notStored()]);
    const runId = controller.ask(THREAD, 'q', COHORT);
    await jest.advanceTimersByTimeAsync(BUSY_POLL_MS);
    expect(turns.map((t) => t.runId)).toEqual([runId, runId]);
    expect(turns[1]).toEqual(turns[0]);
  });

  it('SESSION_BUSY on an ask that started after all: follows its view instead of sending it twice', async () => {
    const { controller, turns, routes, threadActions } = setup(() => bff('SESSION_BUSY', 409));
    const runId = controller.ask(THREAD, 'q', COHORT);
    const executing = { ...J1_EXECUTING, threadId: THREAD, runId };
    const done = { ...J1_DONE, threadId: THREAD, runId };
    routes.view.mockResolvedValueOnce(executing).mockResolvedValueOnce(done);
    await jest.advanceTimersByTimeAsync(BUSY_POLL_MS);
    expect(turns).toHaveLength(1);
    expect(threadActions().slice(-2)).toEqual([{ type: 'view', view: executing }, { type: 'turnSettled', runId }]);
    await jest.advanceTimersByTimeAsync(FOLLOW_POLL_MS);
    expect(threadActions().at(-1)).toEqual({ type: 'view', view: done });
    expect(turns).toHaveLength(1);
  });

  it('SESSION_BUSY on a cancel: resends it after each poll that shows the run unfinished, without waiting for the lease', async () => {
    let calls = 0;
    const executing = { ...J1_EXECUTING, threadId: THREAD, runId: RUN };
    const cancelled = { ...J1_DONE, threadId: THREAD, runId: RUN, status: 'Cancelled' as const };
    const { controller, turns, routes, types } = setup(
      (input) => (++calls <= 2 ? bff('SESSION_BUSY', 409) : [...ok(input).slice(0, 1), { type: 'STATE_SNAPSHOT', snapshot: cancelled }, ok(input)[1]]),
      [executing],
    );
    controller.stop(THREAD, RUN);
    await jest.advanceTimersByTimeAsync(0);
    expect(actionsOf(turns)).toEqual(['cancel']);
    await jest.advanceTimersByTimeAsync(BUSY_POLL_MS);
    // One poll showed the run Executing (a leased status): the cancel goes again at once.
    expect(routes.view).toHaveBeenCalledTimes(1);
    expect(actionsOf(turns)).toEqual(['cancel', 'cancel']);
    expect(turns[1]).toEqual(turns[0]);
    await jest.advanceTimersByTimeAsync(BUSY_POLL_MS);
    expect(routes.view).toHaveBeenCalledTimes(2);
    expect(actionsOf(turns)).toEqual(['cancel', 'cancel', 'cancel']);
    expect(types().slice(-2)).toEqual(['STATE_SNAPSHOT', 'RUN_FINISHED']);
    await jest.advanceTimersByTimeAsync(BUSY_POLL_LIMIT_MS);
    expect(turns).toHaveLength(3);
  });

  it('SESSION_BUSY on a cancel of a run that has ended meanwhile: shows it and sends nothing more', async () => {
    const cancelled = { ...J1_DONE, threadId: THREAD, runId: RUN, status: 'Cancelled' as const };
    const { controller, turns, threadActions } = setup(() => bff('SESSION_BUSY', 409), [cancelled]);
    controller.stop(THREAD, RUN);
    await jest.advanceTimersByTimeAsync(BUSY_POLL_MS * 3);
    expect(actionsOf(turns)).toEqual(['cancel']);
    expect(threadActions().slice(-2)).toEqual([{ type: 'view', view: cancelled }, { type: 'turnSettled', runId: RUN }]);
  });

  it('gives up after 30 s of SESSION_BUSY with a notice', async () => {
    const leased = { ...J1_EXECUTING, threadId: THREAD, runId: RUN };
    const { controller, threadActions, turns } = setup(() => bff('SESSION_BUSY', 409), [leased]);
    controller.resume(THREAD, RUN, { action: 'consent', accept: true }, { status: 'AwaitingConsent', nonce: null });
    await jest.advanceTimersByTimeAsync(BUSY_POLL_LIMIT_MS + BUSY_POLL_MS);
    expect(turns).toHaveLength(1);
    const rejected = { type: 'turnRejected', runId: RUN, code: 'SESSION_BUSY', message: 'the BFF said SESSION_BUSY' };
    const at = threadActions().findIndex((a) => a.type === 'turnRejected');
    expect(threadActions()[at]).toEqual(rejected);
    // The run was still leased: only the view route's reads follow the notice, never a resend.
    expect(threadActions().slice(at + 1).every((a) => a.type === 'view')).toBe(true);
  });

  it('UPSTREAM_TIMEOUT: reads the view first; a 200 shows the run and follows it until it settles', async () => {
    const executing = { ...J1_EXECUTING, threadId: THREAD };
    const done = { ...J1_DONE, threadId: THREAD };
    const { controller, threadActions, routes, turns } = setup(() => bff('UPSTREAM_TIMEOUT', 504), []);
    const runId = controller.ask(THREAD, 'q', COHORT);
    routes.view.mockResolvedValueOnce({ ...executing, runId }).mockResolvedValueOnce({ ...done, runId });
    await jest.advanceTimersByTimeAsync(0);
    expect(threadActions().map((a) => a.type)).toEqual(['submit', 'turn', 'transportError', 'view', 'turnSettled']);
    expect(threadActions()[2]).toMatchObject({ code: 'UPSTREAM_TIMEOUT', checking: true });
    await jest.advanceTimersByTimeAsync(FOLLOW_POLL_MS);
    expect(threadActions().at(-1)).toEqual({ type: 'view', view: { ...done, runId } });
    await jest.advanceTimersByTimeAsync(FOLLOW_POLL_MS * 3);
    expect(routes.view).toHaveBeenCalledTimes(2);
    // Never resent under a new runId.
    expect(turns).toHaveLength(1);
  });

  it('UPSTREAM_ERROR: a 404 view treats the turn as rejected', async () => {
    const { controller, threadActions } = setup(() => bff('UPSTREAM_ERROR', 502), [notStored()]);
    const runId = controller.ask(THREAD, 'q', COHORT);
    await jest.advanceTimersByTimeAsync(0);
    expect(threadActions().at(-1)).toEqual({ type: 'turnRejected', runId, code: 'UPSTREAM_ERROR', message: 'the BFF said UPSTREAM_ERROR' });
  });

  it('restores a stream that ended with no terminal event from the view route', async () => {
    const done = { ...J1_DONE, threadId: THREAD };
    const { controller, threadActions, routes } = setup((input) => [
      { type: 'RUN_STARTED', threadId: input.threadId, runId: input.runId },
    ]);
    const runId = controller.ask(THREAD, 'q', COHORT);
    routes.view.mockResolvedValueOnce({ ...done, runId });
    await jest.advanceTimersByTimeAsync(0);
    expect(threadActions().map((a) => a.type)).toEqual(['submit', 'turn', 'RUN_STARTED', 'transportError', 'view', 'turnSettled']);
    expect(threadActions()[3]).toMatchObject({ code: 'STREAM_ENDED', checking: true });
  });
});

describe('createRunController: the view route', () => {
  it('restores each run from the view route and drops the ones it does not store', async () => {
    const done = { ...J1_DONE, threadId: THREAD, runId: RUN };
    const gone = 'a'.repeat(32);
    const { controller, threadActions, routes } = setup(() => ok({} as RunAgentInput), []);
    routes.view.mockImplementation(async (runId: string) => {
      if (runId === gone) throw notStored();
      return done;
    });
    controller.restore(THREAD, [gone, RUN], RUN);
    await jest.advanceTimersByTimeAsync(0);
    expect(threadActions()).toEqual([
      { type: 'dropRun', runId: gone },
      { type: 'view', view: done },
    ]);
  });

  it('follows a restored latest run that is still leased', async () => {
    const executing = { ...J1_EXECUTING, threadId: THREAD, runId: RUN };
    const done = { ...J1_DONE, threadId: THREAD, runId: RUN };
    const { controller, threadActions } = setup(() => ok({} as RunAgentInput), [executing, done]);
    controller.restore(THREAD, [RUN], RUN);
    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(FOLLOW_POLL_MS);
    expect(threadActions().map((a) => (a.type === 'view' ? a.view.status : a.type))).toEqual(['Executing', 'Complete']);
  });

  it('loads a viz spec with its pinned inputs from the untrimmed view, once', async () => {
    const done = { ...J1_DONE, threadId: THREAD, runId: RUN };
    const { controller, routes } = setup(() => ok({} as RunAgentInput), [done]);
    const spec = await controller.loadSpec(THREAD, RUN, 'v1');
    expect(spec).toEqual(done.vizSpecs[0]);
    expect(await controller.loadSpec(THREAD, RUN, 'v1')).toBe(spec);
    expect(routes.view).toHaveBeenCalledTimes(1);
    expect(await controller.loadSpec(THREAD, RUN, 'v9')).toBeNull();
  });

  it('has no spec to load without a view route', async () => {
    const dispatch = jest.fn();
    const controller = createRunController({ run: async function* () {} }, dispatch);
    expect(controller.routes).toBeNull();
    expect(await controller.loadSpec(THREAD, RUN, 'v1')).toBeNull();
  });
});

describe('createRunController: resumes and Stop', () => {
  it('sends a resume for its run with no question, and resends a Stop on request', async () => {
    const { controller, turns, types } = setup((input) => ok(input));
    controller.resume(THREAD, RUN, { action: 'retry_step', stepId: 's4' }, { status: 'Partial', nonce: null });
    await jest.advanceTimersByTimeAsync(0);
    controller.resendStop(THREAD, RUN);
    await jest.advanceTimersByTimeAsync(0);
    expect(turns.map((t) => [t.runId, t.messages, t.forwardedProps.orion])).toEqual([
      [RUN, [], { action: 'retry_step', stepId: 's4' }],
      [RUN, [], { action: 'cancel' }],
    ]);
    expect(types()).toEqual(['turn', 'RUN_STARTED', 'RUN_FINISHED', 'turn', 'RUN_STARTED', 'RUN_FINISHED']);
  });

  it('sends a resent Stop before the turn queued right after it, without that turn aborting it', async () => {
    const { controller, turns } = setup((input) => ok(input));
    controller.resendStop(THREAD, RUN);
    controller.ask(THREAD, 'next', COHORT);
    await jest.advanceTimersByTimeAsync(0);
    expect(turns.map((t) => [t.forwardedProps.orion.action, t.runId === RUN])).toEqual([
      ['cancel', true],
      ['ask', false],
    ]);
  });

  it('carries cancelWaiting on an ask that cancels the paused run first', async () => {
    const { controller, turns } = setup((input) => ok(input));
    controller.ask(THREAD, 'new question', COHORT, { cancelWaiting: RUN });
    await jest.advanceTimersByTimeAsync(0);
    expect(turns[0].forwardedProps.orion).toEqual({ action: 'ask', question: 'new question', cohortContext: COHORT, cancelWaiting: RUN });
  });

  it('drops events once disposed, and takes them again once activated', async () => {
    const { controller, dispatch } = setup((input) => ok(input));
    controller.dispose();
    controller.ask(THREAD, 'q', COHORT);
    await jest.advanceTimersByTimeAsync(0);
    expect(dispatch).not.toHaveBeenCalled();
    controller.activate();
    controller.ask(THREAD, 'q', COHORT);
    await jest.advanceTimersByTimeAsync(0);
    expect(dispatch).toHaveBeenCalled();
  });
});

/** A controller whose dispatches go through the real tab reducer, so tests read the thread itself. */
const withReducer = (transport: RunTransport) => {
  let tab: TabState = createTab(THREAD);
  const controller = createRunController(transport, (action: TabAction) => {
    tab = tabReducer(tab, action);
  });
  return { controller, thread: () => tab.threads[THREAD] };
};

/** An ask whose stream yields `events` and then fails as a dropped connection does. */
const droppedAsk = (events: (input: RunAgentInput) => AguiEvent[], routes: RunRoutes) => {
  const turns: RunAgentInput[] = [];
  const transport: RunTransport = {
    routes,
    async *run(input): AsyncGenerator<ParseResult> {
      turns.push(input);
      for (const event of events(input)) yield { kind: 'event', event };
      throw new TransportError('NETWORK', 'network error');
    },
  };
  return { transport, turns };
};

const viewRoutes = (view: jest.Mock): RunRoutes => ({
  view,
  record: jest.fn(async () => {
    throw notStored();
  }),
  recordDownloadHref: () => '/record',
});

const offline = () => new TransportError('NETWORK', 'offline');

describe('createRunController: a lost stream whose view read fails too', () => {
  it('keeps reading the view route and follows the run until it settles (no stuck Executing run)', async () => {
    let reads = 0;
    const view = jest.fn(async (runId: string) => {
      reads += 1;
      if (reads === 1) throw offline();
      return { ...J1_DONE, threadId: THREAD, runId };
    });
    const { transport } = droppedAsk(
      (input) => [
        { type: 'RUN_STARTED', threadId: input.threadId, runId: input.runId },
        { type: 'STATE_SNAPSHOT', snapshot: { ...J1_EXECUTING, threadId: input.threadId, runId: input.runId } },
      ],
      viewRoutes(view),
    );
    const { controller, thread } = withReducer(transport);
    const runId = controller.ask(THREAD, 'q', COHORT);
    await jest.advanceTimersByTimeAsync(0);
    expect(view).toHaveBeenCalledTimes(1);
    expect(thread().runs[runId].status).toBe('Executing');
    expect(thread().runs[runId].transportError?.message).toBe("network error; the run's status could not be read either");

    await jest.advanceTimersByTimeAsync(FOLLOW_POLL_MS);
    expect(view).toHaveBeenCalledTimes(2);
    expect(thread().runs[runId].status).toBe('Complete');
    expect(thread().runs[runId].transportError).toBeNull();
    expect(activeRunId(thread())).toBeNull();
    // Settled: no more reads.
    await jest.advanceTimersByTimeAsync(FOLLOW_POLL_MS * 5);
    expect(view).toHaveBeenCalledTimes(2);
  });

  it('does not show an unstarted ask Failed while its state is unknown; a later 404 takes the question back', async () => {
    let reads = 0;
    const view = jest.fn(async () => {
      reads += 1;
      throw reads < 3 ? offline() : notStored();
    });
    const { transport, turns } = droppedAsk(() => [], viewRoutes(view));
    const { controller, thread } = withReducer(transport);
    const runId = controller.ask(THREAD, 'never started', COHORT);
    await jest.advanceTimersByTimeAsync(0);
    expect(thread().runs[runId]).toMatchObject({ status: 'Planning', started: false });
    expect(thread().runs[runId].transportError?.code).toBe('NETWORK');
    await jest.advanceTimersByTimeAsync(FOLLOW_POLL_MS);
    expect(thread().runs[runId].status).toBe('Planning');
    await jest.advanceTimersByTimeAsync(FOLLOW_POLL_MS);
    expect(view).toHaveBeenCalledTimes(3);
    expect(thread().runs[runId]).toBeUndefined();
    expect(thread().notice).toMatchObject({ code: 'UPSTREAM_ERROR', question: 'never started' });
    expect(turns).toHaveLength(1);
  });

  it('leaves the failure standing only once the follow limit passes with no read answered', async () => {
    const view = jest.fn(async () => {
      throw offline();
    });
    const { transport } = droppedAsk(() => [], viewRoutes(view));
    const { controller, thread } = withReducer(transport);
    const runId = controller.ask(THREAD, 'q', COHORT);
    await jest.advanceTimersByTimeAsync(FOLLOW_LIMIT_MS - FOLLOW_POLL_MS);
    expect(thread().runs[runId].status).toBe('Planning');
    await jest.advanceTimersByTimeAsync(FOLLOW_POLL_MS * 2);
    expect(thread().runs[runId]).toMatchObject({ status: 'Failed', started: false });
    expect(activeRunId(thread())).toBeNull();
  });
});

describe('createRunController: a turn that takes over during SESSION_BUSY polling', () => {
  let unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  beforeEach(() => {
    unhandled = [];
    process.on('unhandledRejection', onUnhandled);
  });
  afterEach(() => {
    process.off('unhandledRejection', onUnhandled);
  });

  it('Stop inside the poll wait ends the poll quietly, and viz reports still go standalone afterwards', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const executing = { ...J1_EXECUTING, threadId: THREAD, runId: RUN };
    const { controller, turns } = setup((input) => {
      const { action } = input.forwardedProps.orion;
      if (action === 'ask') return bff('SESSION_BUSY', 409);
      return ok(input, action === 'cancel' ? 'Complete' : 'Recorded');
    }, [executing]);
    const runId = controller.ask(THREAD, 'q', COHORT);
    await jest.advanceTimersByTimeAsync(BUSY_POLL_MS / 2);
    controller.stop(THREAD, runId);
    await jest.advanceTimersByTimeAsync(0);
    expect(actionsOf(turns)).toEqual(['ask', 'cancel']);
    controller.reportViz(THREAD, report('v1'));
    await jest.advanceTimersByTimeAsync(VIZ_REPORT_IDLE_MS);
    expect(actionsOf(turns)).toEqual(['ask', 'cancel', 'viz_report']);
    // Let Node report any rejection nobody handled.
    jest.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(unhandled).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('a turn queued after the aborted poll still waits for the open warm-up (A2)', async () => {
    let release: () => void = () => undefined;
    const warmupOpen = new Promise<void>((resolve) => {
      release = resolve;
    });
    const turns: RunAgentInput[] = [];
    const routes = viewRoutes(jest.fn(async () => ({ ...J1_EXECUTING, threadId: THREAD, runId: RUN })));
    const transport: RunTransport = {
      routes,
      async *run(input): AsyncGenerator<ParseResult> {
        turns.push(input);
        const { action } = input.forwardedProps.orion;
        if (action === 'warmup') {
          await warmupOpen;
          yield* ok(input, 'Recorded').map((event) => ({ kind: 'event' as const, event }));
          return;
        }
        if (action === 'ask') throw bff('SESSION_BUSY', 409);
        for (const event of ok(input)) yield { kind: 'event', event };
      },
    };
    const controller = createRunController(transport, jest.fn());
    controller.warmup(THREAD);
    const runId = controller.ask(THREAD, 'q', COHORT);
    // The warm-up holds the session past QUEUE_WAIT_MS: the ask goes, and is told SESSION_BUSY.
    await jest.advanceTimersByTimeAsync(QUEUE_WAIT_MS);
    expect(actionsOf(turns)).toEqual(['warmup', 'ask']);
    await jest.advanceTimersByTimeAsync(BUSY_POLL_MS / 2);
    controller.stop(THREAD, runId);
    await jest.advanceTimersByTimeAsync(0);
    // The warm-up is still open: the cancel waits for it, as every turn does.
    expect(actionsOf(turns)).toEqual(['warmup', 'ask']);
    release();
    await jest.advanceTimersByTimeAsync(0);
    expect(actionsOf(turns)).toEqual(['warmup', 'ask', 'cancel']);
  });

  it('follows a resumed run still leased when SESSION_BUSY polling gives up', async () => {
    const start = Date.now();
    const view = jest.fn(async () =>
      Date.now() - start < BUSY_POLL_LIMIT_MS + FOLLOW_POLL_MS
        ? { ...J1_EXECUTING, threadId: THREAD, runId: RUN }
        : { ...J1_DONE, threadId: THREAD, runId: RUN },
    );
    const { controller, threadActions, routes } = setup(() => bff('SESSION_BUSY', 409));
    routes.view.mockImplementation(view);
    controller.resume(THREAD, RUN, { action: 'retry_step', stepId: 's4' }, { status: 'Partial', nonce: null });
    await jest.advanceTimersByTimeAsync(BUSY_POLL_LIMIT_MS + BUSY_POLL_MS);
    expect(threadActions().some((a) => a.type === 'turnRejected')).toBe(true);
    await jest.advanceTimersByTimeAsync(FOLLOW_POLL_MS * 3);
    expect(threadActions().at(-1)).toEqual({ type: 'view', view: { ...J1_DONE, threadId: THREAD, runId: RUN } });
  });
});

describe('createRunController: a thread deleted from the tab (release)', () => {
  const OTHER = 'abcdef0123456789abcdef0123456789';

  it('stops following its run: no more view reads, nothing dispatched', async () => {
    const executing = { ...J1_EXECUTING, threadId: THREAD, runId: RUN };
    const { controller, routes, threadActions } = setup(() => ok({} as RunAgentInput), [executing]);
    controller.restore(THREAD, [RUN], RUN);
    await jest.advanceTimersByTimeAsync(FOLLOW_POLL_MS);
    const reads = routes.view.mock.calls.length;
    const seen = threadActions().length;
    expect(reads).toBe(2);
    controller.release(THREAD);
    await jest.advanceTimersByTimeAsync(FOLLOW_POLL_MS * 5);
    expect(routes.view).toHaveBeenCalledTimes(reads);
    expect(threadActions()).toHaveLength(seen);
  });

  it('starts no follower for a restore whose read answers after the release', async () => {
    const executing = { ...J1_EXECUTING, threadId: THREAD, runId: RUN };
    const { controller, routes, dispatch } = setup(() => ok({} as RunAgentInput), [executing]);
    controller.restore(THREAD, [RUN], RUN);
    controller.release(THREAD);
    await jest.advanceTimersByTimeAsync(FOLLOW_POLL_MS * 5);
    expect(routes.view).toHaveBeenCalledTimes(1);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('sends the reports still queued for its runs at once, standalone, and arms no timer for them', async () => {
    const { controller, turns } = setup((input) => ok(input, 'Recorded'));
    controller.reportViz(THREAD, report('v1'));
    controller.release(THREAD);
    await jest.advanceTimersByTimeAsync(0);
    expect(turns.map((t) => [t.threadId, t.forwardedProps.orion])).toEqual([
      [THREAD, { action: 'viz_report', vizId: 'v1', mounted: true, error: null, pinnedHashVerified: true }],
    ]);
    await jest.advanceTimersByTimeAsync(VIZ_REPORT_IDLE_MS * 5);
    expect(turns).toHaveLength(1);
  });

  it('drops a report that fails after the release instead of keeping it for a turn that never comes', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { controller, turns } = setup((input) =>
        input.forwardedProps.orion.action === 'viz_report' ? new TransportError('NETWORK', 'offline') : ok(input),
      );
      controller.reportViz(THREAD, report('v1'));
      controller.release(THREAD);
      await jest.advanceTimersByTimeAsync(VIZ_REPORT_IDLE_MS * 5);
      expect(actionsOf(turns)).toEqual(['viz_report']);
      controller.ask(THREAD, 'q', COHORT);
      await jest.advanceTimersByTimeAsync(0);
      expect(actionsOf(turns)).toEqual(['viz_report']);
      expect(warn).toHaveBeenCalledWith('[orion] viz reports of a deleted thread not recorded', ['v1']);
    } finally {
      warn.mockRestore();
    }
  });

  it('ignores every later call for the thread, and keeps serving the others', async () => {
    const { controller, turns, dispatch, routes } = setup((input) => ok(input));
    controller.release(THREAD);
    controller.warmup(THREAD);
    controller.ask(THREAD, 'q', COHORT);
    controller.stop(THREAD, RUN);
    controller.resendStop(THREAD, RUN);
    controller.resume(THREAD, RUN, { action: 'retry_step', stepId: 's1' }, { status: 'Partial', nonce: null });
    controller.reportViz(THREAD, report('v1'));
    controller.restore(THREAD, [RUN], RUN);
    expect(await controller.loadSpec(THREAD, RUN, 'v1')).toBeNull();
    await jest.advanceTimersByTimeAsync(VIZ_REPORT_IDLE_MS * 2);
    expect(turns).toEqual([]);
    expect(dispatch).not.toHaveBeenCalled();
    expect(routes.view).not.toHaveBeenCalled();

    controller.ask(OTHER, 'q', COHORT);
    await jest.advanceTimersByTimeAsync(0);
    expect(turns.map((t) => [t.threadId, t.forwardedProps.orion.action])).toEqual([[OTHER, 'ask']]);
  });

  it('forgets the specs it cached for the thread', async () => {
    const done = { ...J1_DONE, threadId: THREAD, runId: RUN };
    const { controller, routes } = setup(() => ok({} as RunAgentInput), [done]);
    expect(await controller.loadSpec(THREAD, RUN, 'v1')).toEqual(done.vizSpecs[0]);
    controller.release(THREAD);
    expect(await controller.loadSpec(THREAD, RUN, 'v1')).toBeNull();
    expect(routes.view).toHaveBeenCalledTimes(1);
  });
});

describe('createRunController: busy threads (what deleting a thread would cut off)', () => {
  /** A transport whose warm-up stays open until `release`; every other turn completes. */
  const gatedWarmup = () => {
    let release: () => void = () => undefined;
    const warmupOpen = new Promise<void>((resolve) => {
      release = resolve;
    });
    const turns: RunAgentInput[] = [];
    const transport: RunTransport = {
      async *run(input): AsyncGenerator<ParseResult> {
        turns.push(input);
        if (input.forwardedProps.orion.action === 'warmup') await warmupOpen;
        for (const event of ok(input)) yield { kind: 'event', event };
      },
    };
    return { transport, turns, release: () => release() };
  };

  const RETRY = { action: 'retry_step', stepId: 's1' } as const;
  const PARTIAL = { status: 'Partial', nonce: null } as const;

  it('holds a resume queued behind the warm-up from the call on, while the thread shows no invocation, until it settles', async () => {
    const { transport, turns, release } = gatedWarmup();
    const { controller, thread } = withReducer(transport);
    const heard = jest.fn();
    const unsubscribe = controller.subscribe(heard);
    controller.warmup(THREAD);
    await jest.advanceTimersByTimeAsync(0);
    // A warm-up alone holds nothing a delete would lose.
    expect(controller.busyThreads().size).toBe(0);
    expect(heard).not.toHaveBeenCalled();

    controller.resume(THREAD, RUN, RETRY, PARTIAL);
    expect(controller.busyThreads()).toEqual(new Set([THREAD]));
    expect(heard).toHaveBeenCalledTimes(1);
    const snapshot = controller.busyThreads();
    await jest.advanceTimersByTimeAsync(QUEUE_WAIT_MS / 2);
    expect(actionsOf(turns)).toEqual(['warmup']);
    expect(thread().invocation).toBeNull();
    // The same Set while nothing changes, so state holding it does not render again.
    expect(controller.busyThreads()).toBe(snapshot);

    release();
    await jest.advanceTimersByTimeAsync(0);
    expect(actionsOf(turns)).toEqual(['warmup', 'retry_step']);
    expect(controller.busyThreads().size).toBe(0);
    expect(heard).toHaveBeenCalledTimes(2);
    unsubscribe();
    controller.resume(THREAD, RUN, RETRY, PARTIAL);
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it('lets go of a queued turn that a newer one replaced before it left, and of the newer one once it settles', async () => {
    const { transport, turns, release } = gatedWarmup();
    const controller = createRunController(transport, jest.fn());
    controller.warmup(THREAD);
    controller.resume(THREAD, RUN, RETRY, PARTIAL);
    controller.stop(THREAD, RUN);
    expect(controller.busyThreads().has(THREAD)).toBe(true);
    release();
    await jest.advanceTimersByTimeAsync(0);
    expect(actionsOf(turns)).toEqual(['warmup', 'cancel']);
    expect(controller.busyThreads().has(THREAD)).toBe(false);
  });

  it('holds a failed resume while the view route is checked for its fate, though the thread shows nothing in flight', async () => {
    const paused = replayStream('j3-save-pause');
    const [threadId, runId] = [paused.threadId, paused.runIds[0]];
    const nonce = (J3_PAUSE.pending as { nonce: string }).nonce;
    let reads = 0;
    const view = jest.fn(async () => {
      reads += 1;
      if (reads <= 3) throw offline();
      return J3_PAUSE;
    });
    const { transport } = droppedAsk(() => [], viewRoutes(view));
    let tab: TabState = { ...createTab(threadId), threads: { [threadId]: paused } };
    const controller = createRunController(transport, (action: TabAction) => {
      tab = tabReducer(tab, action);
    });
    controller.resume(threadId, runId, dontSaveAction(nonce), { status: 'AwaitingConfirmation', nonce });
    await jest.advanceTimersByTimeAsync(0);
    const shown = tab.threads[threadId];
    expect(shown.invocation?.closed).toBe(true);
    expect(shown.runs[runId].status).toBe('AwaitingConfirmation');
    expect(threadInFlight(shown)).toBe(false);
    expect(activeRunId(shown)).toBeNull();
    expect(controller.busyThreads().has(threadId)).toBe(true);

    await jest.advanceTimersByTimeAsync(FOLLOW_POLL_MS * 2);
    expect(view).toHaveBeenCalledTimes(3);
    expect(controller.busyThreads().has(threadId)).toBe(true);
    // The record answers: the confirm never landed, the run still waits. Nothing is held now.
    await jest.advanceTimersByTimeAsync(FOLLOW_POLL_MS);
    expect(view).toHaveBeenCalledTimes(4);
    expect(controller.busyThreads().has(threadId)).toBe(false);
  });

  it('holds nothing for a standalone viz report, and nothing once disposed', async () => {
    const { controller, turns } = setup((input) => (input.forwardedProps.orion.action === 'viz_report' ? 'hang' : ok(input)));
    controller.reportViz(THREAD, report('v1'));
    await jest.advanceTimersByTimeAsync(VIZ_REPORT_IDLE_MS);
    expect(actionsOf(turns)).toEqual(['viz_report']);
    expect(controller.busyThreads().size).toBe(0);

    const executing = { ...J1_EXECUTING, threadId: OTHER_THREAD, runId: RUN };
    const following = setup(() => ok({} as RunAgentInput), [executing]);
    following.controller.restore(OTHER_THREAD, [RUN], RUN);
    await jest.advanceTimersByTimeAsync(0);
    expect(following.controller.busyThreads().has(OTHER_THREAD)).toBe(true);
    following.controller.dispose();
    expect(following.controller.busyThreads().size).toBe(0);
  });
});
