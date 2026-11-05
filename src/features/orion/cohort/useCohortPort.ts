import { useMemo } from 'react';
import { useStore } from 'react-redux';
import type { CoreState } from '@gen3/core';
import { storeCohortPort, type CohortPort } from './cohortPort';

/** The platform's cohort store (CoreProvider's), as the two client writes use it. */
export const useCohortPort = (): CohortPort => {
  const store = useStore<CoreState>();
  return useMemo(() => storeCohortPort(store), [store]);
};
