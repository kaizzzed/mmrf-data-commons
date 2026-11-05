import { threadReducer } from '../agui/reducer';
import { loadTab, saveTab, TAB_STORAGE_KEY } from './storage';
import { createTab, tabReducer, type TabState } from './tab';

const THREAD = 'a'.repeat(32);
const RUN = 'b'.repeat(32);

const streamingTab = (): TabState => {
  const tab = createTab(THREAD);
  return tabReducer(tab, {
    type: 'thread',
    threadId: THREAD,
    action: { type: 'submit', runId: RUN, question: 'q', at: '2026-11-04T15:00:00.000Z' },
  });
};

const failingStorage = (): Storage => {
  throw new Error('storage blocked');
};

beforeEach(() => window.sessionStorage.clear());

describe('tab storage', () => {
  it('round-trips a tab through sessionStorage', () => {
    const tab = createTab(THREAD);
    saveTab(tab);
    expect(loadTab()).toEqual(tab);
  });

  it('closes a stream that was open when the tab was saved', () => {
    saveTab(streamingTab());
    const thread = loadTab()?.threads[THREAD];
    expect(thread?.invocation).toEqual({ runId: RUN, kind: 'ask', terminal: false, closed: true });
    expect(thread?.runs[RUN].transportError?.code).toBe('STREAM_ENDED');
  });

  it('leaves finished runs alone', () => {
    const tab = streamingTab();
    const thread = threadReducer(tab.threads[THREAD], {
      type: 'RUN_ERROR',
      message: 'x',
      code: 'INTERNAL_ERROR',
    });
    saveTab({ ...tab, threads: { [THREAD]: thread } });
    expect(loadTab()?.threads[THREAD].runs[RUN].transportError).toBeNull();
  });

  it.each([
    ['nothing stored', null],
    ['invalid JSON', '{'],
    ['another version', JSON.stringify({ ...createTab(THREAD), version: 2 })],
    ['an active thread that is missing', JSON.stringify({ ...createTab(THREAD), activeThreadId: 'x' })],
  ])('returns null for %s', (_label, raw) => {
    if (raw !== null) window.sessionStorage.setItem(TAB_STORAGE_KEY, raw);
    expect(loadTab()).toBeNull();
  });

  it('never throws when storage is unavailable', () => {
    expect(loadTab(failingStorage)).toBeNull();
    expect(() => saveTab(createTab(THREAD), failingStorage)).not.toThrow();
  });
});
