// Test-only helpers for the viz cards; nothing in the app imports this module.

import type { JsonValue, PinnedViz, RunView, VizSpec } from '../agui/types';
import { streamViews, type StreamName } from '../testing';
import { caseIdOfSample } from './spike/krasGroups';

/** The last snapshot of a fixture stream: the run as it ended. */
export const lastView = (name: StreamName): RunView => {
  const views = streamViews(name);
  return views[views.length - 1];
};

/** The run's only viz spec. */
export const onlySpec = (view: RunView): VizSpec => {
  if (view.vizSpecs.length !== 1) throw new Error(`expected one viz spec, found ${view.vizSpecs.length}`);
  return view.vizSpecs[0];
};

/** `{"and": [{"in": {"case_id": [...]}}]}`, the platform's case-list filter. */
export const caseFilter = (caseIds: readonly string[]): { [key: string]: JsonValue } => ({
  and: [{ in: { case_id: [...caseIds] } }],
});

/**
 * de_run's recorded request after Create, as the J3 fixtures build it: each group's name and
 * sample ids, plus the saved cohort's id and its case-ID filter (sample n is case n in the sandbox).
 */
export const savedDeRunRequest = (view: RunView): JsonValue => {
  const spec = onlySpec(view);
  if (!spec.pinned || spec.pinned.kind !== 'deDirect') throw new Error('expected a pinned deDirect spec');
  const groups = spec.pinned.groups.map((g, i) => {
    const cohort = view.cohorts.find((c) => c.ref === spec.cohortRefs[i]);
    return {
      name: g.name,
      sampleIds: [...g.sampleIds],
      ...(cohort?.cohortId ? { cohortId: cohort.cohortId, filter0: caseFilter(g.sampleIds.map(caseIdOfSample)) } : {}),
    };
  });
  return {
    groups,
    method: spec.pinned.method,
    thresholds: { pValueCutoff: 0.05, pValueType: 'adjusted', foldChangeCutoff: 0.3 },
  };
};

/** The untrimmed deInput pinned of j3-deinput, rebuilt from the saved cohorts of j3-after-confirm. */
export const deInputPinned = (view: RunView): PinnedViz => {
  const request = savedDeRunRequest(view) as { groups: { name: string; cohortId: string; filter0: { [key: string]: JsonValue } }[] };
  const [control, kase] = request.groups;
  return {
    kind: 'deInput',
    groups: [
      { name: control.name, cohortId: control.cohortId, filter0: control.filter0 },
      { name: kase.name, cohortId: kase.cohortId, filter0: kase.filter0 },
    ],
  };
};
