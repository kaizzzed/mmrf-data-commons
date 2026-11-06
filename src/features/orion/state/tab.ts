import {
  createThread,
  isInvocationActive,
  isLeasedStatus,
  threadReducer,
  type RunState,
  type ThreadAction,
  type ThreadState,
} from '../agui/reducer';

/** Everything this browser tab shows: its threads, newest first. */
export interface TabState {
  version: 1;
  activeThreadId: string;
  threadIds: string[];
  threads: Record<string, ThreadState>;
}

export type TabAction =
  | { type: 'newThread'; threadId: string }
  | { type: 'selectThread'; threadId: string }
  /**
   * Removes a thread from this tab (the server keeps its run records). The active one hands over
   * to the next thread in the list, else the previous one; the last one to a fresh empty thread
   * under `freshThreadId`, so the tab is never empty. A thread with a run in flight stays, and so
   * does the tab's only thread while it has no runs (`nothingToDelete`).
   */
  | { type: 'deleteThread'; threadId: string; freshThreadId: string }
  | { type: 'thread'; threadId: string; action: ThreadAction };

export const createTab = (threadId: string): TabState => ({
  version: 1,
  activeThreadId: threadId,
  threadIds: [threadId],
  threads: { [threadId]: createThread(threadId) },
});

export const tabReducer = (state: TabState, action: TabAction): TabState => {
  switch (action.type) {
    case 'newThread':
      if (state.threads[action.threadId]) return state;
      return {
        ...state,
        activeThreadId: action.threadId,
        threadIds: [action.threadId, ...state.threadIds],
        threads: { ...state.threads, [action.threadId]: createThread(action.threadId) },
      };
    case 'selectThread':
      return state.threads[action.threadId]
        ? { ...state, activeThreadId: action.threadId }
        : state;
    case 'deleteThread': {
      const thread = state.threads[action.threadId];
      if (!thread || threadInFlight(thread) || nothingToDelete(state.threadIds.length, thread)) return state;
      const index = state.threadIds.indexOf(action.threadId);
      const threadIds = state.threadIds.filter((id) => id !== action.threadId);
      const threads = { ...state.threads };
      delete threads[action.threadId];
      if (threadIds.length === 0) {
        return action.freshThreadId === action.threadId ? state : createTab(action.freshThreadId);
      }
      const activeThreadId =
        state.activeThreadId === action.threadId
          ? (threadIds[index] ?? threadIds[index - 1] ?? threadIds[0])
          : state.activeThreadId;
      return { ...state, activeThreadId, threadIds, threads };
    }
    case 'thread': {
      const thread = state.threads[action.threadId];
      if (!thread) return state;
      const next = threadReducer(thread, action.action);
      return next === thread
        ? state
        : { ...state, threads: { ...state.threads, [action.threadId]: next } };
    }
    default:
      return state;
  }
};

export const activeThread = (state: TabState): ThreadState =>
  state.threads[state.activeThreadId];

export const threadRuns = (thread: ThreadState): RunState[] =>
  thread.runIds.map((id) => thread.runs[id]).filter((run): run is RunState => !!run);

export const threadTitle = (thread: ThreadState): string =>
  threadRuns(thread)[0]?.question || 'New thread';

/**
 * A run of the thread is in flight as the thread shows it: its invocation is open (an ask or a
 * Stop from the click on, any other turn from when it leaves the browser), or a run holds a lease
 * (planning, executing, answering, or stopping while its cancel waits to be confirmed or sent
 * again). Deleting such a thread would leave that stream or follower behind, so it waits. What the
 * thread cannot show (a resume still queued, a failed resume being checked) the controller's
 * busyThreads() answers.
 */
export const threadInFlight = (thread: ThreadState): boolean =>
  isInvocationActive(thread) || threadRuns(thread).some((run) => isLeasedStatus(run.status));

/**
 * The tab's only thread, with no runs: deleting it would only swap it for an identical fresh one
 * (and warm that one up), as New thread declines to stack empty threads. It offers no delete.
 */
export const nothingToDelete = (threadCount: number, thread: ThreadState): boolean =>
  threadCount === 1 && thread.runIds.length === 0;
