import { useMemo } from 'react';
import {
  selectAvailableCohorts,
  selectCurrentCohort,
  useCoreSelector,
  type Cohort,
} from '@gen3/core';
import { COHORT_FILTER_INDEX } from '@/core/constants';
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

export const toCohortContext = (
  active: Cohort | undefined,
  available: readonly Cohort[],
): CohortContext => ({
  active: active ? activeSnapshotOf(active) : NO_ACTIVE_COHORT,
  saved: available.map(snapshotOf),
});

/** Read-only view of the platform's cohorts, in the shape a turn sends. */
export const useCohortContext = (): CohortContext => {
  const active = useCoreSelector((state) => selectCurrentCohort(state));
  const available = useCoreSelector((state) => selectAvailableCohorts(state));
  return useMemo(() => toCohortContext(active, available), [active, available]);
};
