import { useMemo } from 'react';
import {
  selectAvailableCohorts,
  selectCurrentCohort,
  useCoreSelector,
  type Cohort,
} from '@gen3/core';
import { COHORT_FILTER_INDEX } from '@/core/constants';
import { MAX_SAVED_COHORTS } from '../constants';
import type {
  CohortContext,
  CohortSnapshot,
  SavedCohortSnapshot,
  WireFilterSet,
} from '../agui/types';

const EMPTY_FILTERS: WireFilterSet = { mode: 'and', root: {} };

/** What an unfiltered active cohort is called, on the composer chip and in the plan. */
export const ALL_CASES = 'All cases';

/** The cohort bar's own count, which it stores on the cohort once its query returns. */
const caseCountOf = (cohort: Cohort): number | null => {
  const count = cohort.counts?.[COHORT_FILTER_INDEX];
  return typeof count === 'number' ? count : null;
};

const snapshotOf = (cohort: Cohort): SavedCohortSnapshot => ({
  id: cohort.id,
  name: cohort.name,
  filters: cohort.filters?.[COHORT_FILTER_INDEX] ?? EMPTY_FILTERS,
  caseCount: caseCountOf(cohort),
});

const activeSnapshotOf = (cohort: Cohort): CohortSnapshot => {
  const snapshot = snapshotOf(cohort);
  return Object.keys(snapshot.filters.root).length === 0
    ? { ...snapshot, name: ALL_CASES }
    : snapshot;
};

const NO_ACTIVE_COHORT: CohortSnapshot = {
  id: null,
  name: ALL_CASES,
  filters: EMPTY_FILTERS,
  caseCount: null,
};

/**
 * At most MAX_SAVED_COHORTS of the store's cohorts, in the store's order: the active one and then
 * the most recently modified. The agent turns away a turn with more, so past the cap the oldest
 * are left out rather than every question failing.
 */
export const capSaved = (active: Cohort | undefined, available: readonly Cohort[]): readonly Cohort[] => {
  if (available.length <= MAX_SAVED_COHORTS) return available;
  const newestFirst = [...available].sort((a, b) =>
    (b.modifiedDatetime ?? '').localeCompare(a.modifiedDatetime ?? ''),
  );
  const keep = new Set<string>();
  if (active && available.some((c) => c.id === active.id)) keep.add(active.id);
  for (const cohort of newestFirst) {
    if (keep.size >= MAX_SAVED_COHORTS) break;
    keep.add(cohort.id);
  }
  return available.filter((c) => keep.has(c.id));
};

export const toCohortContext = (
  active: Cohort | undefined,
  available: readonly Cohort[],
): CohortContext => ({
  active: active ? activeSnapshotOf(active) : NO_ACTIVE_COHORT,
  saved: capSaved(active, available).map(snapshotOf),
});

/** Read-only view of the platform's cohorts, in the shape a turn sends. */
export const useCohortContext = (): CohortContext => {
  const active = useCoreSelector((state) => selectCurrentCohort(state));
  const available = useCoreSelector((state) => selectAvailableCohorts(state));
  return useMemo(() => toCohortContext(active, available), [active, available]);
};
