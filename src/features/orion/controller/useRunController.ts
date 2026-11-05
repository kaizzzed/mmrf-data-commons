import { useEffect, useMemo, useRef, type Dispatch } from 'react';
import type { ThreadAction } from '../agui/reducer';
import { TransportError, type RunTransport } from '../agui/transport';
import type { CohortContext, OrionAction, RunAgentInput } from '../agui/types';
import { newId } from '../ids';
import type { TabAction } from '../state/tab';

/** A turn waits this long at most for the thread's open invocations, warm-up included. */
const QUEUE_WAIT_MS = 10_000;

export interface RunController {
  warmup(threadId: string): void;
  ask(threadId: string, question: string, cohortContext: CohortContext): void;
  stop(threadId: string, runId: string): void;
}

const turn = (
  threadId: string,
  runId: string,
  orion: OrionAction,
  question?: string,
): RunAgentInput => ({
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

/**
 * Sends turns and feeds their events to the tab reducer. One stream per thread:
 * a new turn on a thread aborts that thread's previous stream, and events from an
 * aborted stream are dropped. A turn leaves the browser only once the thread's open
 * invocations, warm-up included, have settled (A2: one invocation in flight per
 * Runtime session).
 */
export const useRunController = (
  transport: RunTransport,
  dispatch: Dispatch<TabAction>,
): RunController => {
  const streams = useRef(new Map<string, AbortController>());
  const inflight = useRef(new Map<string, Set<Promise<void>>>());
  /** Per thread, the run whose ask is still queued and has not been sent. */
  const unsent = useRef(new Map<string, string>());
  const warmed = useRef(new Set<string>());

  useEffect(() => {
    const open = streams.current;
    const queued = unsent.current;
    return () => {
      for (const controller of open.values()) controller.abort();
      open.clear();
      queued.clear();
    };
  }, []);

  return useMemo(() => {
    const begin = (threadId: string): AbortController => {
      streams.current.get(threadId)?.abort();
      const controller = new AbortController();
      streams.current.set(threadId, controller);
      return controller;
    };

    const track = (threadId: string, invocation: Promise<void>): void => {
      const open = inflight.current.get(threadId) ?? new Set<Promise<void>>();
      inflight.current.set(threadId, open);
      open.add(invocation);
      void invocation.then(() => open.delete(invocation));
    };

    /** Runs `send` once the thread's open invocations settle, and tracks it as open. */
    const enqueue = (threadId: string, send: () => Promise<void> | void): void => {
      const open = Promise.all([...(inflight.current.get(threadId) ?? [])]).then(() => undefined);
      track(threadId, settleWithin(open, QUEUE_WAIT_MS).then(send));
    };

    const pump = async (
      input: RunAgentInput,
      controller: AbortController,
    ): Promise<void> => {
      const { threadId, runId } = input;
      const send = (action: ThreadAction) => {
        if (!controller.signal.aborted) dispatch({ type: 'thread', threadId, action });
      };
      let sawTerminal = false;
      try {
        for await (const item of transport.run(input, controller.signal)) {
          if (item.kind === 'error') {
            send({ type: 'protocolError', runId, error: item.error });
            continue;
          }
          if (item.event.type === 'RUN_FINISHED' || item.event.type === 'RUN_ERROR') {
            sawTerminal = true;
          }
          send(item.event);
        }
        if (!sawTerminal) {
          send({
            type: 'transportError',
            runId,
            code: 'STREAM_ENDED',
            message: 'the stream ended before the run reported how it ended',
          });
        }
      } catch (err) {
        send({
          type: 'transportError',
          runId,
          code: err instanceof TransportError ? err.code : 'NETWORK',
          message: err instanceof Error ? err.message : 'The request failed',
        });
      } finally {
        if (streams.current.get(threadId) === controller) streams.current.delete(threadId);
      }
    };

    return {
      warmup(threadId) {
        if (warmed.current.has(threadId)) return;
        warmed.current.add(threadId);
        const input = turn(threadId, newId(), { action: 'warmup' });
        enqueue(threadId, () =>
          drain(transport.run(input, new AbortController().signal)).catch(
            () => undefined, // A failed warm-up only makes the first answer slower.
          ),
        );
      },
      ask(threadId, question, cohortContext) {
        const runId = newId();
        dispatch({
          type: 'thread',
          threadId,
          action: { type: 'submit', runId, question, at: new Date().toISOString() },
        });
        const controller = begin(threadId);
        const input = turn(threadId, runId, { action: 'ask', question, cohortContext }, question);
        unsent.current.set(threadId, runId);
        enqueue(threadId, () => {
          if (unsent.current.get(threadId) === runId) unsent.current.delete(threadId);
          return controller.signal.aborted ? undefined : pump(input, controller);
        });
      },
      stop(threadId, runId) {
        if (unsent.current.get(threadId) === runId) {
          // The server never saw this run, so a cancel turn would only get RUN_NOT_FOUND.
          unsent.current.delete(threadId);
          streams.current.get(threadId)?.abort();
          streams.current.delete(threadId);
          dispatch({ type: 'thread', threadId, action: { type: 'withdraw', runId } });
          return;
        }
        // Aborting the ask's stream first frees the session for the cancel turn.
        const controller = begin(threadId);
        dispatch({ type: 'thread', threadId, action: { type: 'stop', runId } });
        const input = turn(threadId, runId, { action: 'cancel' });
        enqueue(threadId, () => (controller.signal.aborted ? undefined : pump(input, controller)));
      },
    };
  }, [transport, dispatch]);
};
