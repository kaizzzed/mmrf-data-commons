import { createThread, threadReducer, type RunState, type ThreadState } from '../agui/reducer';
import { streamEvents, streamRunId, type StreamName } from '../testing';
import { describeRunChange } from './announce';

/** Every announcement a stream makes for its own run, in order, as the live region would get them. */
const announcements = (name: StreamName): string[] => {
  const events = streamEvents(name);
  const runId = streamRunId(name);
  let thread: ThreadState = createThread(
    (events.find((e) => e.type === 'STATE_SNAPSHOT') as { snapshot: { threadId: string } }).snapshot.threadId,
  );
  const said: string[] = [];
  for (const event of events) {
    const before: RunState | undefined = thread.runs[runId];
    thread = threadReducer(thread, event);
    const after = thread.runs[runId];
    if (after && after !== before) {
      const text = describeRunChange(before, after);
      if (text) said.push(text);
    }
  }
  return said;
};

describe('describeRunChange (the polite live region)', () => {
  it('announces each step change and the finished answer', () => {
    const said = announcements('j1-complete');
    expect(said).toContain('Step s1 fixture_fingerprint: Running.');
    expect(said.some((s) => s.includes('Step s4 survival_compare: Done.'))).toBe(true);
    expect(said.some((s) => s.endsWith('Writing interpretation.'))).toBe(true);
    expect(said.at(-1)).toBe('Answer ready: Complete.');
  });

  it('announces a waiting card, so focus can stay in the composer (E21)', () => {
    expect(announcements('j3-save-pause').at(-1)).toContain('Waiting for you: save 2 cohorts?');
    expect(announcements('clarify').at(-1)).toBe('Question for you: Which classification defines high risk?');
    expect(announcements('consent').at(-1)).toBe('Needs your choice: use Correlation Plot instead of OncoMatrix?');
  });

  it('announces a new plan version after an edit', () => {
    const said = announcements('j3-edit-at-pause');
    expect(said[0]).toContain('Plan version 2.');
  });

  it('says a run ended without an answer plainly', () => {
    expect(announcements('interrupted').at(-1)).toBe('Run ended: Not supported.');
    expect(announcements('j1-stop').at(-1)).toContain('Answer ready: Stopped by you.');
  });
});
