import type { ThreadState } from '../agui/reducer';
import type { TabState } from './tab';

export const TAB_STORAGE_KEY = 'orion:assistant:v1';

type StorageGetter = () => Storage;
const sessionStore: StorageGetter = () => window.sessionStorage;

const isTabState = (value: unknown): value is TabState => {
  if (typeof value !== 'object' || value === null) return false;
  const tab = value as Partial<TabState>;
  return (
    tab.version === 1 &&
    typeof tab.activeThreadId === 'string' &&
    Array.isArray(tab.threadIds) &&
    typeof tab.threads === 'object' &&
    tab.threads !== null &&
    tab.activeThreadId in tab.threads &&
    tab.threadIds.every((id) => typeof id === 'string' && id in (tab.threads ?? {}))
  );
};

/** A stream cannot survive a reload; mark the run so the screen stops waiting on it. */
const closeLostStream = (thread: ThreadState): ThreadState => {
  const invocation = thread.invocation;
  if (!invocation || invocation.terminal || invocation.closed) return thread;
  const run = thread.runs[invocation.runId];
  return {
    ...thread,
    invocation: { ...invocation, closed: true },
    runs: run
      ? {
          ...thread.runs,
          [run.runId]: {
            ...run,
            transportError: {
              code: 'STREAM_ENDED',
              message: 'the stream stopped when the Assistant closed or reloaded',
            },
          },
        }
      : thread.runs,
  };
};

export const loadTab = (storage: StorageGetter = sessionStore): TabState | null => {
  try {
    const raw = storage().getItem(TAB_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isTabState(parsed)) return null;
    const threads: Record<string, ThreadState> = {};
    for (const id of parsed.threadIds) threads[id] = closeLostStream(parsed.threads[id]);
    return { ...parsed, threads };
  } catch {
    return null;
  }
};

export const saveTab = (tab: TabState, storage: StorageGetter = sessionStore): void => {
  try {
    storage().setItem(TAB_STORAGE_KEY, JSON.stringify(tab));
  } catch {
    // The thread still works in memory when storage is full or blocked.
  }
};
