import {
  Accessibility,
  createNewCohort,
  explorerApi,
  selectAvailableCohorts,
  selectCohortById,
  selectCurrentCohortId,
  setCurrentCohortId,
  type Cohort,
  type CoreState,
  type FilterSet,
} from '@gen3/core';
import { COHORT_FILTER_INDEX } from '@/core/constants';
import type { WireFilterSet } from '../agui/types';
import { defSha256, filterSetSha256 } from './cohortDef';

/** A cohort as the platform's store holds it: one FilterSet per data index. */
export interface StoredCohort {
  id: string;
  name: string;
  filters: Record<string, WireFilterSet | undefined>;
}

/**
 * The cohort store as the two client writes see it. The browser owns saved cohorts and the active
 * cohort (C-4); `create` is `createNewCohort`, which returns no id and renames a clashing name.
 */
export interface CohortPort {
  list(): StoredCohort[];
  get(id: string): StoredCohort | null;
  currentId(): string | null;
  create(name: string, filters: WireFilterSet): void;
  setCurrent(id: string): void;
  /** Asks the platform to count the cohort, as the cohort bar does, so its count fills in. */
  refreshCount(id: string): void;
}

const EMPTY_FILTERS: WireFilterSet = { mode: 'and', root: {} };

/** defSha256 of the empty filter: an unfiltered cohort is all cases. */
export const ALL_CASES_SHA256 = defSha256({ kind: 'filter', clauses: [] });

/**
 * defSha256 of a stored cohort's case filters, or null when ORION cannot read them. A cohort that
 * also filters another index is never identical to a definition ORION would save.
 */
export const storedCohortSha256 = (cohort: StoredCohort): string | null => {
  const others = Object.entries(cohort.filters).filter(
    ([index, filters]) => index !== COHORT_FILTER_INDEX && filters && Object.keys(filters.root ?? {}).length > 0,
  );
  if (others.length > 0) return null;
  return filterSetSha256(cohort.filters[COHORT_FILTER_INDEX] ?? EMPTY_FILTERS);
};

const stored = (cohort: Cohort): StoredCohort => ({
  id: cohort.id,
  name: cohort.name,
  filters: (cohort.filters ?? {}) as Record<string, WireFilterSet | undefined>,
});

/** What the port needs of a Redux store: react-redux's `useStore()` gives it. */
export interface CoreStoreLike {
  getState(): CoreState;
  dispatch(action: unknown): unknown;
}

interface Subscription {
  unsubscribe?: () => void;
  unwrap?: () => Promise<unknown>;
}

/** The platform's cohort store behind the port. */
export const storeCohortPort = (store: CoreStoreLike): CohortPort => ({
  list: () => selectAvailableCohorts(store.getState()).map(stored),
  get: (id) => {
    const cohort = selectCohortById(store.getState(), id);
    return cohort ? stored(cohort) : null;
  },
  currentId: () => selectCurrentCohortId(store.getState()) ?? null,
  create: (name, filters) => {
    store.dispatch(
      createNewCohort({
        name,
        filters: { [COHORT_FILTER_INDEX]: filters as unknown as FilterSet },
        setAsCurrent: false,
      }),
    );
  },
  setCurrent: (id) => {
    store.dispatch(setCurrentCohortId(id));
  },
  refreshCount: (id) => {
    const cohort = selectCohortById(store.getState(), id);
    if (!cohort) return;
    // The core listener files a fulfilled count under `queryId`, the cohort id (as CountsPanel does).
    const request = store.dispatch(
      explorerApi.endpoints.getCounts.initiate({
        type: COHORT_FILTER_INDEX,
        filters: cohort.filters?.[COHORT_FILTER_INDEX] ?? (EMPTY_FILTERS as unknown as FilterSet),
        accessibility: Accessibility.ALL,
        queryId: id,
        indexPrefix: 'CaseCentric_',
      }),
    ) as Subscription;
    void request.unwrap?.().catch(() => undefined).finally(() => request.unsubscribe?.());
  },
});
