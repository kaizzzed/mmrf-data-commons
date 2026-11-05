import type { RunView } from '../agui/types';
import {
  deInputFallback,
  handoffFor,
  MAKE_ACTIVE_LABEL,
  NOT_SAVED_REASON,
  OPEN_LABEL,
  pinnedToSkipped,
  settingsToReapply,
  UNKNOWN_COHORT_REASON,
  WRITE_SKIPPED_REASON,
} from './handoff';
import { lastView, onlySpec } from './testing';

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
    const handoff = handoffOf(lastView('oncomatrix'));
    expect(handoff.disabledReason).toBe(NOT_SAVED_REASON);
    expect(handoff.cohortNames).toEqual(['CGS high-risk cases']);
    expect(handoff.settings[0]).toBe('Cohort: CGS high-risk cases');
    expect(handoff.settings[1]).toBe('Genes, in this order: KRAS, NRAS, DIS3');
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
