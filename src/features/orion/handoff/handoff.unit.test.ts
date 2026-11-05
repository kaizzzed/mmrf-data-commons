import { selectCurrentCohortId } from '@gen3/core';
import type { RunView } from '../agui/types';
import { createWriteLog } from '../cohort/writeLog';
import { createTestCohortStore, recordingNotifier, streamViews } from '../testing';
import { HANDOFF_SKIPPED_REASON, handoffTarget, openInTool } from './handoff';

const THREAD = 't'.repeat(32);
const RUN = 'r'.repeat(32);
const AFTER_CONFIRM = streamViews('j3-after-confirm').pop() as RunView;
const DONT_SAVE = streamViews('j3-dont-save').pop() as RunView;

const setup = () => {
  const store = createTestCohortStore(
    [
      { id: 'c-all', name: 'Cohort' },
      { id: '9a1e3c5b-7d2f-4a6e-b8c0-4e6a8c0e2b57', name: 'KRAS mutated (ORION)' },
    ],
    'c-all',
  );
  const notify = recordingNotifier();
  const navigate = jest.fn();
  const log = createWriteLog(() => undefined);
  return { store, notify, navigate, log, deps: { port: store.port, log, notify, navigate } };
};

describe('handoffTarget', () => {
  it('opens on the first pinned cohort with a platform id', () => {
    expect(handoffTarget(AFTER_CONFIRM, ['kras_mut', 'kras_wt'])).toEqual({
      cohortId: '9a1e3c5b-7d2f-4a6e-b8c0-4e6a8c0e2b57',
      cohortName: 'KRAS mutated (ORION)',
      disabledReason: null,
    });
  });

  it('opens all cases (no switch) for the unsaved scope', () => {
    expect(handoffTarget(AFTER_CONFIRM, ['base'])).toEqual({ cohortId: null, cohortName: null, disabledReason: null });
  });

  it("is off for a card pinned to cohorts the researcher chose not to save, quoting the limitation (C-16)", () => {
    expect(handoffTarget(DONT_SAVE, ['kras_wt', 'kras_mut'])).toEqual({
      cohortId: null,
      cohortName: null,
      disabledReason: DONT_SAVE.limitations.find((l) => l.code === 'WRITE_SKIPPED')?.text,
    });
    expect(handoffTarget({ ...DONT_SAVE, limitations: [] }, ['kras_wt']).disabledReason).toBe(HANDOFF_SKIPPED_REASON);
  });
});

describe('openInTool', () => {
  it('makes the card\'s cohort active (a logged write with undo), then opens the tool in this tab', () => {
    const { deps, store, notify, navigate, log } = setup();
    const id = '9a1e3c5b-7d2f-4a6e-b8c0-4e6a8c0e2b57';
    expect(openInTool(deps, { appId: 'DE', cohortId: id, threadId: THREAD, runId: RUN })).toBe(true);
    expect(selectCurrentCohortId(store.state())).toBe(id);
    expect(navigate).toHaveBeenCalledWith('DE');
    expect(log.entries()).toEqual([
      expect.objectContaining({ action: 'set_active_cohort', runId: RUN, threadId: THREAD, detail: 'make_active_and_open', cohortId: id }),
    ]);
    expect(notify.undos.map((u) => u.message)).toEqual(['Active cohort: KRAS mutated (ORION).']);
    expect(notify.undos[0].onUndo()).toBe(true);
    expect(selectCurrentCohortId(store.state())).toBe('c-all');
  });

  it('opens without a switch when the cohort is already active, or there is none', () => {
    const { deps, navigate, notify, log } = setup();
    openInTool(deps, { appId: 'Correlation', cohortId: 'c-all', threadId: THREAD, runId: RUN });
    openInTool(deps, { appId: 'Correlation', cohortId: null, threadId: THREAD, runId: RUN });
    expect(navigate).toHaveBeenCalledTimes(2);
    expect(notify.undos).toEqual([]);
    expect(log.entries()).toEqual([]);
  });

  it('does not open when the cohort is gone from the list, and says why', () => {
    const { deps, navigate, notify } = setup();
    expect(openInTool(deps, { appId: 'DE', cohortId: 'c-gone', cohortName: 'Old cohort', threadId: THREAD, runId: RUN })).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
    expect(notify.errors).toEqual(['Old cohort is no longer in the cohort list, so the tool did not open.']);
  });
});
