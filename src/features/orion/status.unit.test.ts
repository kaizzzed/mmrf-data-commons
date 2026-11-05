import { RUN_STATUSES, STEP_STATUSES, type RunStatus, type StepStatus } from './agui/types';
import { RUN_STATUS_VOCAB, STEP_STATUS_VOCAB } from './status';

// F2 "Run and step states": one screen word per state.
const RUN_WORDS: Record<RunStatus, string> = {
  Planning: 'Planning',
  Clarifying: 'Question for you',
  AwaitingConsent: 'Needs your choice',
  Executing: 'Running',
  AwaitingConfirmation: 'Waiting for you',
  Stopping: 'Stopping',
  Answering: 'Writing interpretation',
  Complete: 'Complete',
  Partial: 'Partial: a step failed',
  Limited: 'Stopped by a limitation',
  Unsupported: 'Not supported',
  ObservedOnly: 'Interpretation withheld',
  Cancelled: 'Stopped by you',
  Failed: 'Failed',
  Interrupted: 'Interrupted',
};

const STEP_WORDS: Record<StepStatus, string> = {
  Queued: 'Next',
  AwaitingUser: 'Needs you',
  Running: 'Running',
  Retrying: 'Retrying',
  Done: 'Done',
  Empty: 'Empty',
  Failed: 'Failed',
  Skipped: 'Skipped',
  Reused: 'Reused',
};

describe('status vocabulary', () => {
  it('covers exactly the 15 run statuses and the 9 step statuses', () => {
    expect(RUN_STATUSES).toHaveLength(15);
    expect(STEP_STATUSES).toHaveLength(9);
    expect(Object.keys(RUN_STATUS_VOCAB).sort()).toEqual([...RUN_STATUSES].sort());
    expect(Object.keys(STEP_STATUS_VOCAB).sort()).toEqual([...STEP_STATUSES].sort());
  });

  it.each(RUN_STATUSES.map((s): [RunStatus, string] => [s, RUN_WORDS[s]]))('run %s reads "%s"', (status, word) => {
    expect(RUN_STATUS_VOCAB[status].word).toBe(word);
  });

  it.each(STEP_STATUSES.map((s): [StepStatus, string] => [s, STEP_WORDS[s]]))('step %s reads "%s"', (status, word) => {
    expect(STEP_STATUS_VOCAB[status].word).toBe(word);
  });

  it('pairs every state with an icon', () => {
    for (const vocab of [...Object.values(RUN_STATUS_VOCAB), ...Object.values(STEP_STATUS_VOCAB)]) {
      expect(typeof vocab.Icon).toBe('function');
    }
  });

  it('spins only for in-flight states', () => {
    const spinning = (vocab: Record<string, { spinning: boolean }>) =>
      Object.entries(vocab)
        .filter(([, v]) => v.spinning)
        .map(([k]) => k);
    expect(spinning(RUN_STATUS_VOCAB)).toEqual(['Planning', 'Executing']);
    expect(spinning(STEP_STATUS_VOCAB)).toEqual(['Running']);
  });
});
