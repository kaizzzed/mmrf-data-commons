import { createThread, threadReducer, type ThreadAction, type ThreadState } from '../agui/reducer';
import { replayStream } from '../testing';
import { loadTab, saveTab } from './storage';
import { activeThread, createTab, nothingToDelete, tabReducer, threadInFlight, threadTitle, type TabState } from './tab';

const id = (c: string) => c.repeat(32);
const [A, B, C, FRESH] = [id('a'), id('b'), id('c'), id('f')];
const AT = '2026-11-06T12:00:00.000Z';

const apply = (thread: ThreadState, ...actions: ThreadAction[]): ThreadState => actions.reduce(threadReducer, thread);

/** A thread whose one run asked `question` and finished Complete: nothing in flight. */
const finished = (threadId: string, question: string): ThreadState => {
  const runId = `${threadId.slice(0, 31)}1`;
  return apply(
    createThread(threadId),
    { type: 'submit', runId, question, at: AT },
    { type: 'RUN_STARTED', threadId, runId },
    { type: 'RUN_FINISHED', threadId, runId, result: { status: 'Complete', code: null } },
  );
};

/** A tab of these threads in this order (newest first), the first one active. */
const tabOf = (...threads: ThreadState[]): TabState => ({
  version: 1,
  activeThreadId: threads[0].threadId,
  threadIds: threads.map((t) => t.threadId),
  threads: Object.fromEntries(threads.map((t) => [t.threadId, t])),
});

const remove = (tab: TabState, threadId: string): TabState =>
  tabReducer(tab, { type: 'deleteThread', threadId, freshThreadId: FRESH });

describe('tabReducer deleteThread', () => {
  it('removes an inactive thread and leaves the active one on screen', () => {
    const tab = tabOf(finished(A, 'first'), finished(B, 'second'), finished(C, 'third'));
    const next = remove(tab, B);
    expect(next.threadIds).toEqual([A, C]);
    expect(Object.keys(next.threads).sort()).toEqual([A, C]);
    expect(next.activeThreadId).toBe(A);
    expect(next.threads[A]).toBe(tab.threads[A]);
  });

  it('hands the active thread over to the next one in the list', () => {
    const tab = tabReducer(tabOf(finished(A, 'first'), finished(B, 'second'), finished(C, 'third')), {
      type: 'selectThread',
      threadId: B,
    });
    const next = remove(tab, B);
    expect(next.threadIds).toEqual([A, C]);
    expect(next.activeThreadId).toBe(C);
  });

  it('hands over to the previous one when the active thread was the last in the list', () => {
    const tab = tabReducer(tabOf(finished(A, 'first'), finished(B, 'second')), { type: 'selectThread', threadId: B });
    const next = remove(tab, B);
    expect(next.threadIds).toEqual([A]);
    expect(next.activeThreadId).toBe(A);
    expect(threadTitle(activeThread(next))).toBe('first');
  });

  it('replaces the only thread with a fresh empty one, so the tab is never empty', () => {
    const next = remove(tabOf(finished(A, 'only')), A);
    expect(next).toEqual(createTab(FRESH));
    expect(threadTitle(activeThread(next))).toBe('New thread');
  });

  it("keeps the tab's only thread while it has no runs: deleting it would bring back the same one", () => {
    const tab = createTab(A);
    expect(nothingToDelete(1, tab.threads[A])).toBe(true);
    expect(remove(tab, A)).toBe(tab);
  });

  it('lets an empty thread go while others remain, and an only thread that has runs', () => {
    const tab = tabOf(createThread(A), finished(B, 'second'));
    expect(nothingToDelete(2, tab.threads[A])).toBe(false);
    expect(remove(tab, A).threadIds).toEqual([B]);
    expect(nothingToDelete(1, finished(C, 'only'))).toBe(false);
  });

  it('never reuses the deleted id for the fresh thread', () => {
    const tab = tabOf(finished(A, 'only'));
    expect(tabReducer(tab, { type: 'deleteThread', threadId: A, freshThreadId: A })).toBe(tab);
  });

  it('ignores a thread the tab does not have', () => {
    const tab = tabOf(finished(A, 'first'));
    expect(remove(tab, B)).toBe(tab);
  });

  it('can delete a thread whose run waits on the researcher (no stream, nothing followed)', () => {
    const paused = replayStream('j3-save-pause');
    expect(threadInFlight(paused)).toBe(false);
    const tab = tabOf(finished(A, 'first'), paused);
    expect(remove(tab, paused.threadId).threadIds).toEqual([A]);
  });

  it('survives a reload: the stored tab no longer has the thread', () => {
    window.sessionStorage.clear();
    saveTab(remove(tabOf(finished(A, 'first'), finished(B, 'second')), A));
    const loaded = loadTab();
    expect(loaded?.threadIds).toEqual([B]);
    expect(loaded?.activeThreadId).toBe(B);
    expect(loaded?.threads[A]).toBeUndefined();
  });
});

describe('the in-flight guard', () => {
  const runId = `${A.slice(0, 31)}9`;
  const asked = apply(createThread(A), { type: 'submit', runId, question: 'q', at: AT });
  const started = apply(asked, { type: 'RUN_STARTED', threadId: A, runId });
  const cases: [string, ThreadState][] = [
    ['an ask queued or streaming (its invocation is open)', asked],
    [
      'a lost stream whose run the view route is still following',
      apply(started, { type: 'transportError', runId, code: 'NETWORK', message: 'reset', checking: true }),
    ],
    ['a Stop on its way', apply(started, { type: 'stop', runId })],
    [
      'a Stop whose cancel turn failed, waiting to go again ahead of the next turn',
      apply(started, { type: 'stop', runId }, { type: 'transportError', runId, code: 'NETWORK', message: 'reset' }),
    ],
  ];

  it.each(cases)('keeps a thread with %s', (_, thread) => {
    expect(threadInFlight(thread)).toBe(true);
    const tab = tabOf(thread, finished(B, 'other'));
    expect(remove(tab, A)).toBe(tab);
  });

  it('lets the thread go once its run has ended', () => {
    const ended = apply(started, { type: 'RUN_FINISHED', threadId: A, runId, result: { status: 'Complete', code: null } });
    expect(threadInFlight(ended)).toBe(false);
    expect(remove(tabOf(ended, finished(B, 'other')), A).threadIds).toEqual([B]);
  });

  it('lets an unused thread go', () => {
    expect(threadInFlight(createThread(A))).toBe(false);
  });
});
