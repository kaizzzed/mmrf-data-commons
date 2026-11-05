import type { Dispatch } from 'react';
import {
  isEndStatus,
  isLeasedStatus,
  isRejectionCode,
  type InvocationKind,
  type NoticeCode,
  type ThreadAction,
} from '../agui/reducer';
import { bffHandling, TransportError, type RunRoutes, type RunTransport } from '../agui/transport';
import type {
  AguiEvent,
  CohortContext,
  OrionAction,
  RunAgentInput,
  RunStatus,
  RunView,
  VizReport,
  VizSpec,
} from '../agui/types';
import { newId } from '../ids';
import type { TabAction } from '../state/tab';

/** A turn waits this long at most for the thread's open invocations, warm-up included. */
export const QUEUE_WAIT_MS = 10_000;
/** SESSION_BUSY: the view route is polled this often, for this long (contract "Client handling of BFF errors"). */
export const BUSY_POLL_MS = 2_000;
export const BUSY_POLL_LIMIT_MS = 30_000;
/** A run followed through the view route (a lost stream, a restored run) is polled this often. */
export const FOLLOW_POLL_MS = 2_000;
/** Past this, a followed run is left as the view route last showed it. */
export const FOLLOW_LIMIT_MS = 15 * 60_000;
/** A queued viz report goes standalone this long after the last one, if no turn is open. */
export const VIZ_REPORT_IDLE_MS = 2_000;
/** At most this many reports ride on one turn. */
export const MAX_VIZ_REPORTS = 8;

export type ResumeAction = Extract<
  OrionAction,
  { action: 'clarify_answer' | 'consent' | 'confirm' | 'edit_plan' | 'retry_step' }
>;

/** What the run looked like when the click sent the action: a resend needs it unchanged. */
export interface ResumeExpectation {
  status: RunStatus;
  nonce: string | null;
}

export interface AskOptions {
  /** The paused run the researcher chose to cancel before this question runs. */
  cancelWaiting?: string;
}

export interface RunController {
  warmup(threadId: string): void;
  ask(threadId: string, question: string, cohortContext: CohortContext, options?: AskOptions): string;
  stop(threadId: string, runId: string): void;
  /** A Stop no snapshot has confirmed yet is sent again, ahead of the thread's next turn. */
  resendStop(threadId: string, runId: string): void;
  resume(threadId: string, runId: string, action: ResumeAction, expect: ResumeExpectation): void;
  reportViz(threadId: string, report: VizReport): void;
  /** Reloads runs from the view route: the record wins; a run it does not store leaves the thread. */
  restore(threadId: string, runIds: readonly string[], latestRunId: string | null): void;
  /** A viz spec with its pinned inputs, from the untrimmed view route; null when it has none. */
  loadSpec(threadId: string, runId: string, vizId: string): Promise<VizSpec | null>;
  readonly routes: RunRoutes | null;
  /** Aborts every stream and timer and drops later events, until `activate` (strict mode remounts). */
  dispose(): void;
  activate(): void;
}

interface TurnContext {
  threadId: string;
  runId: string;
  kind: InvocationKind;
  input: RunAgentInput;
  /** The reports that rode on this turn: queued again if it is turned away. */
  reports: VizReport[];
  expect: ResumeExpectation | null;
  /** SESSION_BUSY polling ends here, across resends of the same turn. */
  busyDeadline: number | null;
}

const buildInput = (threadId: string, runId: string, orion: OrionAction, question?: string): RunAgentInput => ({
  threadId,
  runId,
  state: {},
  messages: question ? [{ id: newId(), role: 'user', content: question }] : [],
  tools: [],
  context: [],
  forwardedProps: { orion },
});

const drain = async (items: AsyncIterable<unknown>): Promise<void> => {
  const iterator = items[Symbol.asyncIterator]();
  while (!(await iterator.next()).done) {
    // Warm-up output is not shown.
  }
};

const settleWithin = (promise: Promise<void>, ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    promise.then(done, done);
  });

class Aborted extends Error {}

const wait = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Aborted());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Aborted());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });

const isTerminal = (event: AguiEvent): boolean => event.type === 'RUN_FINISHED' || event.type === 'RUN_ERROR';

const pendingNonce = (view: RunView): string | null => (view.pending?.kind === 'confirm' ? view.pending.nonce : null);

const notFound = (err: unknown): boolean => err instanceof TransportError && err.bffCode === 'RUN_NOT_FOUND';

/**
 * Sends turns and feeds their events to the tab reducer. One stream per thread: a new turn on a
 * thread aborts that thread's previous stream, and events from an aborted stream are dropped. A
 * turn leaves the browser only once the thread's open invocations, warm-up included, have
 * settled (A2: one invocation in flight per Runtime session). BFF errors are handled by code
 * (types.ts BFF_ERROR_HANDLING); a stream that ends without a terminal event is restored from
 * the view route.
 */
export const createRunController = (
  transport: RunTransport,
  dispatch: Dispatch<TabAction>,
): RunController => {
  const routes = transport.routes ?? null;
  const streams = new Map<string, AbortController>();
  const followers = new Map<string, AbortController>();
  const inflight = new Map<string, Set<Promise<void>>>();
  /** Per thread, the run whose ask is still queued and has not been sent. */
  const unsent = new Map<string, string>();
  const warmed = new Set<string>();
  const vizQueue = new Map<string, VizReport[]>();
  const vizTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const specs = new Map<string, Promise<VizSpec | null>>();
  /** Turns that must not be aborted by the thread's next turn (a resent Stop queued ahead of it). */
  const detached = new Set<AbortController>();
  let disposed = false;

  const toThread = (threadId: string, action: ThreadAction): void => {
    if (!disposed) dispatch({ type: 'thread', threadId, action });
  };

  const stopFollowing = (threadId: string): void => {
    followers.get(threadId)?.abort();
    followers.delete(threadId);
  };

  const begin = (threadId: string): AbortController => {
    streams.get(threadId)?.abort();
    stopFollowing(threadId);
    const controller = new AbortController();
    streams.set(threadId, controller);
    return controller;
  };

  const track = (threadId: string, invocation: Promise<void>): void => {
    const open = inflight.get(threadId) ?? new Set<Promise<void>>();
    inflight.set(threadId, open);
    open.add(invocation);
    void invocation.then(() => open.delete(invocation));
  };

  /** Runs `send` once the thread's open invocations settle, and tracks it as open. */
  const enqueue = (threadId: string, send: () => Promise<void> | void): void => {
    const open = Promise.all([...(inflight.get(threadId) ?? [])]).then(() => undefined);
    track(threadId, settleWithin(open, QUEUE_WAIT_MS).then(send));
  };

  // ------------------------------------------------------------ viz reports

  const takeReports = (threadId: string): VizReport[] => {
    const queue = vizQueue.get(threadId) ?? [];
    vizQueue.set(threadId, queue.slice(MAX_VIZ_REPORTS));
    return queue.slice(0, MAX_VIZ_REPORTS);
  };

  /** Reports a turned-away turn carried go back to the front; a newer report of a viz wins. */
  const requeue = (threadId: string, reports: VizReport[]): void => {
    if (reports.length === 0) return;
    const queue = vizQueue.get(threadId) ?? [];
    const newer = (r: VizReport) => queue.some((q) => q.runId === r.runId && q.vizId === r.vizId);
    vizQueue.set(threadId, [...reports.filter((r) => !newer(r)), ...queue]);
  };

  const sendStandaloneReport = async (threadId: string, report: VizReport): Promise<void> => {
    const { runId, vizId, mounted, error, pinnedHashVerified } = report;
    const input = buildInput(threadId, runId, { action: 'viz_report', vizId, mounted, error, pinnedHashVerified });
    try {
      for await (const item of transport.run(input, new AbortController().signal)) {
        if (item.kind === 'event' && item.event.type === 'RUN_ERROR') {
          // An unknown run or viz is dropped and logged by the agent too; it never comes back.
          console.warn('[orion] viz report not recorded', { runId, vizId, code: item.event.code });
        }
      }
    } catch {
      // Not delivered: it rides on the thread's next turn instead.
      requeue(threadId, [report]);
    }
  };

  /** 2 s after the last report: standalone if no invocation is open, else they ride on the next turn. */
  const flushReports = (threadId: string): void => {
    vizTimers.delete(threadId);
    if (disposed || (inflight.get(threadId)?.size ?? 0) > 0) return;
    const reports = vizQueue.get(threadId) ?? [];
    vizQueue.set(threadId, []);
    for (const report of reports) enqueue(threadId, () => sendStandaloneReport(threadId, report));
  };

  // ------------------------------------------------------------ the view route

  /** Polls a run until it leaves a leased status; views only ever replace older ones. */
  const follow = (threadId: string, runId: string): void => {
    if (!routes || disposed) return;
    stopFollowing(threadId);
    const controller = new AbortController();
    followers.set(threadId, controller);
    const deadline = Date.now() + FOLLOW_LIMIT_MS;
    void (async () => {
      try {
        while (Date.now() < deadline) {
          await wait(FOLLOW_POLL_MS, controller.signal);
          let view: RunView;
          try {
            view = await routes.view(runId, threadId, controller.signal);
          } catch (err) {
            if (controller.signal.aborted) return;
            if (notFound(err)) {
              toThread(threadId, { type: 'dropRun', runId });
              return;
            }
            continue;
          }
          if (controller.signal.aborted) return;
          toThread(threadId, { type: 'view', view });
          if (!isLeasedStatus(view.status)) return;
        }
      } catch (err) {
        if (!(err instanceof Aborted)) throw err;
      } finally {
        if (followers.get(threadId) === controller) followers.delete(threadId);
      }
    })();
  };

  /**
   * A turn whose stream failed or ended without a terminal event (or a BFF 502 or 504): the view
   * route says what became of its run. 200 shows that run and follows it while it is leased; 404
   * means the turn never started, so it is rejected (an ask's question goes back to the composer).
   */
  const checkView = async (
    ctx: TurnContext,
    signal: AbortSignal,
    code: NoticeCode,
    message: string,
  ): Promise<void> => {
    const { threadId, runId } = ctx;
    if (!routes) return;
    let view: RunView;
    try {
      view = await routes.view(runId, threadId, signal);
    } catch (err) {
      if (signal.aborted) return;
      if (notFound(err)) {
        requeue(threadId, ctx.reports);
        toThread(threadId, { type: 'turnRejected', runId, code, message });
      } else {
        toThread(threadId, {
          type: 'transportError',
          runId,
          code: err instanceof TransportError ? err.code : 'NETWORK',
          message: `${message}; the run's status could not be read either`,
        });
      }
      return;
    }
    if (signal.aborted) return;
    toThread(threadId, { type: 'view', view });
    toThread(threadId, { type: 'turnSettled', runId });
    if (isLeasedStatus(view.status)) follow(threadId, runId);
  };

  /** SESSION_BUSY: wait for the run to leave a leased status, then resend only if the action still applies. */
  const pollView = async (ctx: TurnContext, controller: AbortController, message: string): Promise<void> => {
    const { threadId, runId } = ctx;
    if (!routes) {
      requeue(threadId, ctx.reports);
      toThread(threadId, { type: 'turnRejected', runId, code: 'SESSION_BUSY', message });
      return;
    }
    const deadline = ctx.busyDeadline ?? Date.now() + BUSY_POLL_LIMIT_MS;
    const giveUp = () => {
      requeue(threadId, ctx.reports);
      toThread(threadId, { type: 'turnRejected', runId, code: 'SESSION_BUSY', message });
    };
    while (Date.now() < deadline) {
      await wait(BUSY_POLL_MS, controller.signal);
      let view: RunView | null;
      try {
        view = await routes.view(runId, threadId, controller.signal);
      } catch (err) {
        if (controller.signal.aborted) return;
        if (!notFound(err)) continue;
        view = null;
      }
      if (controller.signal.aborted) return;
      if (view === null) {
        if (ctx.kind === 'ask') {
          // The ask never started: send it again under the same runId.
          await pump({ ...ctx, busyDeadline: deadline }, controller);
        } else {
          requeue(threadId, ctx.reports);
          toThread(threadId, { type: 'turnRejected', runId, code: 'RUN_NOT_FOUND', message });
        }
        return;
      }
      toThread(threadId, { type: 'view', view });
      if (ctx.kind === 'ask') {
        // It started after all: follow the run instead of sending it twice.
        toThread(threadId, { type: 'turnSettled', runId });
        if (isLeasedStatus(view.status)) follow(threadId, runId);
        return;
      }
      if (isLeasedStatus(view.status)) continue;
      const expect = ctx.expect;
      // A resume applies only while the run still waits for it; a Stop, while the run has not ended.
      const stillWaits = expect
        ? view.status === expect.status && pendingNonce(view) === expect.nonce
        : !isEndStatus(view.status);
      if (stillWaits) {
        await pump({ ...ctx, busyDeadline: deadline }, controller);
      } else {
        toThread(threadId, { type: 'turnSettled', runId });
      }
      return;
    }
    giveUp();
  };

  // ------------------------------------------------------------ turns

  const pump = async (ctx: TurnContext, controller: AbortController): Promise<void> => {
    const { threadId, runId, input } = ctx;
    const live = () => !controller.signal.aborted && !disposed;
    const send = (action: ThreadAction) => {
      if (live()) toThread(threadId, action);
    };
    send({ type: 'turn', runId, kind: ctx.kind, action: input.forwardedProps.orion.action });
    let terminal: AguiEvent | null = null;
    try {
      for await (const item of transport.run(input, controller.signal)) {
        if (item.kind === 'error') {
          send({ type: 'protocolError', runId, error: item.error });
          continue;
        }
        if (isTerminal(item.event)) terminal = item.event;
        send(item.event);
      }
    } catch (err) {
      if (!live()) return;
      if (err instanceof TransportError && err.bffCode) {
        const { bffCode } = err;
        switch (bffHandling(bffCode)) {
          case 'reject':
            requeue(threadId, ctx.reports);
            send({ type: 'turnRejected', runId, code: bffCode, message: err.message });
            return;
          case 'notStored':
            requeue(threadId, ctx.reports);
            send({ type: 'turnRejected', runId, code: 'RUN_NOT_FOUND', message: err.message });
            return;
          case 'pollView':
            await pollView(ctx, controller, err.message);
            return;
          case 'checkView':
            send({ type: 'transportError', runId, code: bffCode, message: err.message, checking: !!routes });
            await checkView(ctx, controller.signal, bffCode, err.message);
            return;
        }
      }
      requeue(threadId, ctx.reports);
      const code = err instanceof TransportError ? err.code : 'NETWORK';
      const message = err instanceof Error ? err.message : 'The request failed';
      send({ type: 'transportError', runId, code, message, checking: !!routes });
      await checkView(ctx, controller.signal, 'UPSTREAM_ERROR', message);
      return;
    }
    if (!live()) return;
    if (!terminal) {
      requeue(threadId, ctx.reports);
      const message = 'the stream ended before the run reported how it ended';
      send({ type: 'transportError', runId, code: 'STREAM_ENDED', message, checking: !!routes });
      await checkView(ctx, controller.signal, 'UPSTREAM_ERROR', message);
      return;
    }
    if (terminal.type === 'RUN_ERROR' && isRejectionCode(terminal.code)) requeue(threadId, ctx.reports);
  };

  const sendTurn = (
    threadId: string,
    runId: string,
    orion: OrionAction,
    kind: InvocationKind,
    controller: AbortController,
    options: { question?: string; expect?: ResumeExpectation | null; onSend?: () => void } = {},
  ): void => {
    enqueue(threadId, () => {
      options.onSend?.();
      if (controller.signal.aborted || disposed) return undefined;
      const reports = takeReports(threadId);
      const action: OrionAction = reports.length > 0 ? { ...orion, vizReports: reports } : orion;
      const ctx: TurnContext = {
        threadId,
        runId,
        kind,
        input: buildInput(threadId, runId, action, options.question),
        reports,
        expect: options.expect ?? null,
        busyDeadline: null,
      };
      return pump(ctx, controller).finally(() => {
        if (streams.get(threadId) === controller) streams.delete(threadId);
      });
    });
  };

  return {
    routes,
    warmup(threadId) {
      if (warmed.has(threadId)) return;
      warmed.add(threadId);
      const input = buildInput(threadId, newId(), { action: 'warmup' });
      enqueue(threadId, () =>
        drain(transport.run(input, new AbortController().signal)).catch(
          () => undefined, // A failed warm-up only makes the first answer slower.
        ),
      );
    },
    ask(threadId, question, cohortContext, options = {}) {
      const runId = newId();
      toThread(threadId, { type: 'submit', runId, question, at: new Date().toISOString() });
      const controller = begin(threadId);
      unsent.set(threadId, runId);
      const orion: OrionAction = {
        action: 'ask',
        question,
        cohortContext,
        ...(options.cancelWaiting ? { cancelWaiting: options.cancelWaiting } : {}),
      };
      sendTurn(threadId, runId, orion, 'ask', controller, {
        question,
        onSend: () => {
          if (unsent.get(threadId) === runId) unsent.delete(threadId);
        },
      });
      return runId;
    },
    stop(threadId, runId) {
      if (unsent.get(threadId) === runId) {
        // The server never saw this run, so a cancel turn would only get RUN_NOT_FOUND.
        unsent.delete(threadId);
        streams.get(threadId)?.abort();
        streams.delete(threadId);
        toThread(threadId, { type: 'withdraw', runId });
        return;
      }
      // Aborting the open stream first frees the session for the cancel turn.
      const controller = begin(threadId);
      toThread(threadId, { type: 'stop', runId });
      sendTurn(threadId, runId, { action: 'cancel' }, 'cancel', controller);
    },
    resendStop(threadId, runId) {
      // Queued ahead of the turn that follows it, which must not abort it: it owns no stream slot.
      const controller = new AbortController();
      detached.add(controller);
      sendTurn(threadId, runId, { action: 'cancel' }, 'cancel', controller);
      void Promise.all([...(inflight.get(threadId) ?? [])]).then(() => detached.delete(controller));
    },
    resume(threadId, runId, action, expect) {
      const controller = begin(threadId);
      sendTurn(threadId, runId, action, 'other', controller, { expect });
    },
    reportViz(threadId, report) {
      const queue = (vizQueue.get(threadId) ?? []).filter(
        (r) => !(r.runId === report.runId && r.vizId === report.vizId),
      );
      vizQueue.set(threadId, [...queue, report]);
      const timer = vizTimers.get(threadId);
      if (timer !== undefined) clearTimeout(timer);
      vizTimers.set(threadId, setTimeout(() => flushReports(threadId), VIZ_REPORT_IDLE_MS));
    },
    restore(threadId, runIds, latest) {
      if (!routes || runIds.length === 0) return;
      void (async () => {
        for (const runId of runIds) {
          let view: RunView;
          try {
            view = await routes.view(runId, threadId);
          } catch (err) {
            // RUN_NOT_FOUND: the run is not stored (yet), so it leaves the thread; anything else
            // keeps the copy this tab cached.
            if (notFound(err)) toThread(threadId, { type: 'dropRun', runId });
            continue;
          }
          toThread(threadId, { type: 'view', view });
          if (runId === latest && isLeasedStatus(view.status) && !streams.has(threadId)) follow(threadId, runId);
        }
      })();
    },
    loadSpec(threadId, runId, vizId) {
      const key = `${runId}/${vizId}`;
      const cached = specs.get(key);
      if (cached) return cached;
      if (!routes) return Promise.resolve(null);
      const loading = routes.view(runId, threadId).then(
        (view) => view.vizSpecs.find((s) => s.vizId === vizId && s.pinned !== null) ?? null,
        () => null,
      );
      specs.set(key, loading);
      // Only a found spec stays cached: a failed read is tried again next time.
      void loading.then((spec) => {
        if (!spec) specs.delete(key);
      });
      return loading;
    },
    activate() {
      disposed = false;
    },
    dispose() {
      disposed = true;
      for (const controller of streams.values()) controller.abort();
      for (const controller of followers.values()) controller.abort();
      for (const controller of detached) controller.abort();
      for (const timer of vizTimers.values()) clearTimeout(timer);
      streams.clear();
      followers.clear();
      detached.clear();
      vizTimers.clear();
      unsent.clear();
    },
  };
};
