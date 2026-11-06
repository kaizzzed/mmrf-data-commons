import {
  createThread,
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
