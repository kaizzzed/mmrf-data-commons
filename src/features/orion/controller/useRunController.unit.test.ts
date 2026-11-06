import { act, renderHook } from '@testing-library/react';
import type { ParseResult } from '../agui/sseParser';
import { fixtureTransport, type RunTransport } from '../agui/transport';
import type { AguiEvent, CohortContext, RunAgentInput } from '../agui/types';
import type { TabAction } from '../state/tab';
import { useBusyThreads, useRunController } from './useRunController';

const THREAD = '0123456789abcdef0123456789abcdef';
const COHORT: CohortContext = {
  active: { id: null, name: 'All cases', filters: { mode: 'and', root: {} }, caseCount: 1000 },
  saved: [],
};

/** The fixture replay with a warm-up that stays open until `release` is called. */
const slowWarmup = () => {
  const inner = fixtureTransport({ delayMs: 50 });
  const sent: string[] = [];
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const transport: RunTransport = {
    async *run(input: RunAgentInput, signal: AbortSignal): AsyncGenerator<ParseResult> {
      sent.push(input.forwardedProps.orion.action);
      if (input.forwardedProps.orion.action === 'warmup') await gate;
      yield* inner.run(input, signal);
    },
  };
  return { transport, sent, release: () => release() };
};

/** Answers every ask with the given frames and nothing else. */
const answeringAsk = (frames: (input: RunAgentInput) => AguiEvent[]): RunTransport => ({
  async *run(input: RunAgentInput): AsyncGenerator<ParseResult> {
    if (input.forwardedProps.orion.action !== 'ask') return;
    for (const event of frames(input)) yield { kind: 'event', event };
  },
});

const threadActionTypes = (dispatch: jest.Mock<void, [TabAction]>): string[] =>
  dispatch.mock.calls.flatMap(([action]) => (action.type === 'thread' ? [action.action.type] : []));

const submittedRunId = (dispatch: jest.Mock<void, [TabAction]>): string => {
  for (const [action] of dispatch.mock.calls) {
    if (action.type === 'thread' && action.action.type === 'submit') return action.action.runId;
  }
  throw new Error('nothing was submitted');
};

describe('useRunController', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('sends the ask only after the warm-up, or after waiting 10 s for it', async () => {
    const { transport, sent } = slowWarmup();
    const dispatch = jest.fn<void, [TabAction]>();
    const { result } = renderHook(() => useRunController(transport, dispatch));
    await act(async () => {
      result.current.warmup(THREAD);
      result.current.ask(THREAD, 'q', COHORT);
      await jest.advanceTimersByTimeAsync(9_000);
    });
    expect(sent).toEqual(['warmup']);
    await act(() => jest.advanceTimersByTimeAsync(1_000));
    expect(sent).toEqual(['warmup', 'ask']);
  });

  it('queues the cancel behind a warm-up that is still in flight', async () => {
    const { transport, sent, release } = slowWarmup();
    const dispatch = jest.fn<void, [TabAction]>();
    const { result } = renderHook(() => useRunController(transport, dispatch));
    await act(async () => {
      result.current.warmup(THREAD);
      result.current.ask(THREAD, 'q', COHORT);
      await jest.advanceTimersByTimeAsync(10_000);
    });
    expect(sent).toEqual(['warmup', 'ask']);

    await act(async () => {
      result.current.stop(THREAD, submittedRunId(dispatch));
      await jest.advanceTimersByTimeAsync(1_000);
    });
    expect(sent).toEqual(['warmup', 'ask']);

    await act(async () => {
      release();
      await jest.advanceTimersByTimeAsync(1_000);
    });
    expect(sent).toEqual(['warmup', 'ask', 'cancel']);
    const finished = dispatch.mock.calls
      .map(([action]) => action)
      .filter((action) => action.type === 'thread' && action.action.type === 'RUN_FINISHED');
    expect(finished.at(-1)).toMatchObject({ action: { result: { status: 'Cancelled' } } });
  });

  it.each([
    ['a rejection after RUN_STARTED', (input: RunAgentInput): AguiEvent[] => [
      { type: 'RUN_STARTED', threadId: input.threadId, runId: input.runId },
      { type: 'RUN_ERROR', code: 'RUN_BUSY', message: 'busy' },
    ]],
    ['a lone id rejection', (): AguiEvent[] => [
      { type: 'RUN_ERROR', code: 'INVALID_INPUT', message: 'bad ids' },
    ]],
  ])('passes %s to the reducer as the turn\'s end, not as a transport error', async (_label, frames) => {
    const dispatch = jest.fn<void, [TabAction]>();
    const { result } = renderHook(() => useRunController(answeringAsk(frames), dispatch));
    await act(async () => {
      result.current.ask(THREAD, 'q', COHORT);
      await jest.advanceTimersByTimeAsync(0);
    });
    const types = threadActionTypes(dispatch);
    expect(types[0]).toBe('submit');
    expect(types.at(-1)).toBe('RUN_ERROR');
    expect(types).not.toContain('transportError');
  });

  it('withdraws an ask stopped before it was sent, with no turn at all', async () => {
    const { transport, sent, release } = slowWarmup();
    const dispatch = jest.fn<void, [TabAction]>();
    const { result } = renderHook(() => useRunController(transport, dispatch));
    await act(async () => {
      result.current.warmup(THREAD);
      result.current.ask(THREAD, 'q', COHORT);
      await jest.advanceTimersByTimeAsync(100);
    });
    const runId = submittedRunId(dispatch);
    act(() => result.current.stop(THREAD, runId));
    expect(dispatch).toHaveBeenLastCalledWith({
      type: 'thread',
      threadId: THREAD,
      action: { type: 'withdraw', runId },
    });

    await act(async () => {
      release();
      await jest.advanceTimersByTimeAsync(20_000);
    });
    expect(sent).toEqual(['warmup']);
  });
});

describe('useBusyThreads', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('renders the threads the controller holds a turn for, from the call until the turn has settled', async () => {
    const { transport, sent, release } = slowWarmup();
    const dispatch = jest.fn<void, [TabAction]>();
    const { result } = renderHook(() => {
      const controller = useRunController(transport, dispatch);
      return { controller, busy: useBusyThreads(controller) };
    });
    expect(result.current.busy.size).toBe(0);
    act(() => result.current.controller.warmup(THREAD));
    expect(result.current.busy.size).toBe(0);
    act(() => {
      result.current.controller.ask(THREAD, 'q', COHORT);
    });
    expect([...result.current.busy]).toEqual([THREAD]);
    await act(async () => {
      release();
      await jest.advanceTimersByTimeAsync(5_000);
    });
    expect(sent).toEqual(['warmup', 'ask']);
    expect(result.current.busy.size).toBe(0);
  });
});
