import { createContext } from 'react';

/** F3 "How many viewers stay live": the two newest. */
export const MAX_LIVE_VIZ = 2;

/**
 * Which viz cards hold a live ProteinPaint viewer. Activating a card makes it the newest;
 * past the cap the oldest one freezes. Shaped for `useSyncExternalStore`.
 */
export interface LiveVizRegistry {
  activate(vizId: string): void;
  release(vizId: string): void;
  subscribe(listener: () => void): () => void;
  /** Live card ids, oldest first; a new array only when membership changes. */
  snapshot(): readonly string[];
}

export const createLiveVizRegistry = (cap: number = MAX_LIVE_VIZ): LiveVizRegistry => {
  let live: readonly string[] = [];
  const listeners = new Set<() => void>();
  const set = (next: readonly string[]) => {
    if (next.length === live.length && next.every((id, i) => id === live[i])) return;
    live = next;
    listeners.forEach((listener) => listener());
  };
  return {
    activate: (vizId) => set([...live.filter((id) => id !== vizId), vizId].slice(-cap)),
    release: (vizId) => set(live.filter((id) => id !== vizId)),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot: () => live,
  };
};

/** One registry per page: ProteinPaint's body-level leftovers are per page, not per thread. */
export const LiveVizContext = createContext<LiveVizRegistry>(createLiveVizRegistry());
