import type { Cohort } from '@gen3/core';
import { ALL_CASES, toCohortContext } from './useCohortContext';

const BLACK_PATIENTS = {
  mode: 'and',
  root: { race: { operator: 'in', field: 'race', operands: ['black or african american'] } },
} as const;

const cohort = (patch: Partial<Cohort>): Cohort => ({
  id: 'c-1',
  name: 'Cohort',
  filters: {},
  createdDatetime: '2026-11-04T15:00:00.000Z',
  modifiedDatetime: '2026-11-04T15:00:00.000Z',
  ...patch,
});

describe('toCohortContext', () => {
  it('names an unfiltered active cohort "All cases" and sends the count the cohort bar stored', () => {
    const active = cohort({ counts: { case_centric: 1000 } });
    const { active: snapshot, saved } = toCohortContext(active, [active]);
    expect(snapshot).toEqual({
      id: 'c-1',
      name: ALL_CASES,
      filters: { mode: 'and', root: {} },
      caseCount: 1000,
    });
    // Saved cohorts keep the names their owners gave them.
    expect(saved[0].name).toBe('Cohort');
  });

  it('keeps a filtered cohort its own name and count', () => {
    const active = cohort({
      name: 'Black patients',
      filters: { case_centric: BLACK_PATIENTS },
      counts: { case_centric: 334 },
    });
    expect(toCohortContext(active, []).active).toEqual({
      id: 'c-1',
      name: 'Black patients',
      filters: BLACK_PATIENTS,
      caseCount: 334,
    });
  });

  it('sends a null count until the cohort bar has one', () => {
    expect(toCohortContext(cohort({}), []).active.caseCount).toBeNull();
    expect(toCohortContext(cohort({ counts: { data_file: 12 } }), []).active.caseCount).toBeNull();
    expect(toCohortContext(undefined, []).active).toEqual({
      id: null,
      name: ALL_CASES,
      filters: { mode: 'and', root: {} },
      caseCount: null,
    });
  });
});
