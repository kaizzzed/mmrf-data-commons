import { selectCurrentCohortId } from '@gen3/core';
import type { RunView } from '../agui/types';
import { createWriteLog } from '../cohort/writeLog';
import { createTestCohortStore, recordingNotifier, streamViews } from '../testing';
import { lastView, onlySpec } from '../viz/testing';
import {
  deInputFallback,
  handoffFor,
  MAKE_ACTIVE_LABEL,
  NOT_SAVED_REASON,
  OPEN_LABEL,
  openInTool,
  pinnedToSkipped,
  scopeHandoff,
  settingsToReapply,
  UNKNOWN_COHORT_REASON,
  WRITE_SKIPPED_REASON,
} from './handoff';

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

describe('scopeHandoff (a limitation card\'s Open on this cohort)', () => {
  it('opens on the run\'s scope: no switch for all cases', () => {
    expect(scopeHandoff('CohortComparison', AFTER_CONFIRM)).toMatchObject({
      appId: 'CohortComparison',
      cohortId: null,
      disabledReason: null,
      cohortNames: ['All cases'],
    });
  });

  it('opens on a saved scope cohort, reading Make active and open when another is active', () => {
    const scoped: RunView = {
      ...AFTER_CONFIRM,
      cohorts: AFTER_CONFIRM.cohorts.map((c) => (c.ref === 'base' ? { ...c, source: 'saved_cohort', cohortId: 'c-scope', name: 'Scope' } : c)),
    };
    expect(scopeHandoff('DE', scoped, 'c-all')).toMatchObject({ cohortId: 'c-scope', label: MAKE_ACTIVE_LABEL, disabledReason: null });
  });

  it('opens with no switch when the run lists no scope cohort (an Unsupported run has no plan)', () => {
    expect(scopeHandoff('SetOperations', { cohorts: [], limitations: [] })).toEqual({
      appId: 'SetOperations',
      cohortId: null,
      label: OPEN_LABEL,
      disabledReason: null,
      cohortNames: [],
      settings: [],
    });
  });

  it("is off when the scope is a cohort the researcher chose not to save, quoting the limitation (C-16)", () => {
    const skipped: RunView = {
      ...DONT_SAVE,
      cohorts: DONT_SAVE.cohorts.map((c) => (c.ref === 'base' ? { ...c, save: 'skipped' } : c)),
    };
    expect(scopeHandoff('DE', skipped).disabledReason).toBe(DONT_SAVE.limitations.find((l) => l.code === 'WRITE_SKIPPED')?.text);
    expect(scopeHandoff('DE', { ...skipped, limitations: [] }).disabledReason).toBe(WRITE_SKIPPED_REASON);
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

const handoffOf = (view: RunView, activeCohortId?: string | null) => {
  const spec = onlySpec(view);
  return handoffFor(spec, spec.pinned, view, activeCohortId);
};

describe('handoffFor', () => {
  it('opens a scope-wide card on all cases with no cohort switch (J1)', () => {
    const handoff = handoffOf(lastView('j1-complete'));
    expect(handoff).toEqual({
      appId: 'Correlation',
      cohortId: null,
      label: OPEN_LABEL,
      disabledReason: null,
      cohortNames: ['All cases'],
      settings: ['Cohort: All cases', 'Survival variable: overall_survival', 'Overlay: cgs_risk_category'],
    });
    // A null cohort never asks for a switch, whatever is active.
    expect(handoffOf(lastView('j1-complete'), 'some-active-cohort').label).toBe(OPEN_LABEL);
  });

  it('opens DE on the two saved groups with no switch, listing the settings to re-apply (J3)', () => {
    const handoff = handoffOf(lastView('j3-after-confirm'));
    expect(handoff.disabledReason).toBeNull();
    expect(handoff.cohortId).toBeNull();
    expect(handoff.cohortNames).toEqual(['KRAS not detected (ORION)', 'KRAS mutated (ORION)']);
    expect(handoff.settings).toEqual([
      'Groups: KRAS not detected (ORION) (control), then KRAS mutated (ORION) (case)',
      'Method: Wilcoxon',
      'Volcano: -log10 p cutoff 1.3 (adjusted p), log2FC cutoff 0.3',
    ]);
  });

  it("turns hand-off off after Don't save, quoting the WRITE_SKIPPED line (C-16)", () => {
    const view = lastView('j3-dont-save');
    const handoff = handoffOf(view);
    expect(handoff.disabledReason).toBe(
      "You chose Don't save, so no cohort was saved: the chart uses the unsaved groups and Open with this cohort is off.",
    );
    expect(pinnedToSkipped(onlySpec(view), view)).toBe(true);
    expect(handoffOf({ ...view, limitations: [] }).disabledReason).toBe(WRITE_SKIPPED_REASON);
  });

  it('cannot open on a planned cohort that was never saved', () => {
    // The oncomatrix fixture's cohort is reused (already saved); the same card on a cohort with no
    // platform id has nothing to open.
    const view = lastView('oncomatrix');
    const unsaved: RunView = {
      ...view,
      cohorts: view.cohorts.map((c) => (c.ref === 'high' ? { ...c, save: 'none', cohortId: null, savedName: null } : c)),
    };
    const handoff = handoffOf(unsaved);
    expect(handoff.disabledReason).toBe(NOT_SAVED_REASON);
    expect(handoff.cohortNames).toEqual(['CGS high-risk (ORION)']);
    expect(handoff.settings[0]).toBe('Cohort: CGS high-risk (ORION)');
    expect(handoff.settings[1]).toBe('Genes, in this order: KRAS, NRAS, DIS3');
  });

  it('opens the cohort the plan reused at compile time', () => {
    expect(handoffOf(lastView('oncomatrix'), null)).toMatchObject({
      cohortId: '3c7a1e9b-5d2f-4b8a-9e6c-1f0d2a4b6c88',
      disabledReason: null,
      cohortNames: ['CGS high-risk (ORION)'],
    });
  });

  it('opens a saved cohort, reading "Make active and open" when another cohort is active', () => {
    const view = lastView('oncomatrix');
    const saved: RunView = {
      ...view,
      cohorts: view.cohorts.map((c) => (c.ref === 'high' ? { ...c, save: 'saved', cohortId: 'c-high', savedName: 'CGS high risk' } : c)),
    };
    expect(handoffOf(saved)).toMatchObject({ cohortId: 'c-high', label: OPEN_LABEL, cohortNames: ['CGS high risk'] });
    expect(handoffOf(saved, 'c-high').label).toBe(OPEN_LABEL);
    expect(handoffOf(saved, 'c-other').label).toBe(MAKE_ACTIVE_LABEL);
    expect(handoffOf(saved, null).label).toBe(MAKE_ACTIVE_LABEL);
  });

  it('refuses a card whose cohort the run does not list', () => {
    const view = lastView('j1-complete');
    expect(handoffFor({ ...onlySpec(view), cohortRefs: ['ghost'] }, null, view).disabledReason).toBe(UNKNOWN_COHORT_REASON);
  });
});

describe('settingsToReapply', () => {
  it('lists DEinput groups and the method its caption asks for', () => {
    expect(
      settingsToReapply(
        {
          kind: 'deInput',
          groups: [
            { name: 'A (ORION)', cohortId: 'a', filter0: { and: [] } },
            { name: 'B (ORION)', cohortId: 'b', filter0: { and: [] } },
          ],
        },
        [],
      ),
    ).toEqual(['Groups: A (ORION) (control), then B (ORION) (case)', 'Method: Wilcoxon']);
  });

  it('lists only the cohort while the pinned inputs are still loading', () => {
    const view = lastView('j1-complete');
    expect(settingsToReapply(null, view.cohorts.slice(0, 1))).toEqual(['Cohort: All cases']);
  });
});

describe('deInputFallback', () => {
  it('is available for a direct DE card on two saved cohorts', () => {
    const view = lastView('j3-after-confirm');
    expect(deInputFallback(onlySpec(view), view)).toEqual({ available: true });
  });

  it("is off after Don't save (C-16)", () => {
    const view = lastView('j3-dont-save');
    const fallback = deInputFallback(onlySpec(view), view);
    expect(fallback.available).toBe(false);
    if (!fallback.available) expect(fallback.reason).toMatch(/Don't save/);
  });

  it('needs both groups saved, and applies only to a direct DE card', () => {
    const view = lastView('j3-after-confirm');
    const unsaved: RunView = {
      ...view,
      cohorts: view.cohorts.map((c) => (c.ref === 'kras_mut' ? { ...c, save: 'proposed', cohortId: null } : c)),
    };
    expect(deInputFallback(onlySpec(unsaved), unsaved).available).toBe(false);
    const j1 = lastView('j1-complete');
    expect(deInputFallback(onlySpec(j1), j1).available).toBe(false);
  });
});
