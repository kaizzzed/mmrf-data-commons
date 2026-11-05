import type { ThreadAction } from '../agui/reducer';
import type { ParseResult } from '../agui/sseParser';
import { TransportError, type RunRoutes, type RunTransport } from '../agui/transport';
import type { AguiEvent, CohortContext, RunAgentInput, RunView, VizReport } from '../agui/types';
import type { TabAction } from '../state/tab';
import { streamViews } from '../testing';
import {
  BUSY_POLL_LIMIT_MS,
  BUSY_POLL_MS,
  createRunController,
  FOLLOW_POLL_MS,
  VIZ_REPORT_IDLE_MS,
  type RunController,
} from './runController';

const THREAD = '0123456789abcdef0123456789abcdef';
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
    expect(threadActions().at(-1)).toEqual({ type: 'turnRejected', runId: RUN, code: 'SESSION_BUSY', message: 'the BFF said SESSION_BUSY' });
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
