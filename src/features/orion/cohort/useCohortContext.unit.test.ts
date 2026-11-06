import type { Cohort } from '@gen3/core';
import { ALL_CASES, toCohortContext } from './useCohortContext';
import { MAX_SAVED_COHORTS } from '../constants';

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

  it('sends at most 200 saved cohorts, the agent\'s cap: the active one and the most recently modified', () => {
    const at = (i: number) => `2026-11-04T15:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`;
    // 205 cohorts, oldest first; the active one is the oldest of all.
    const available = Array.from({ length: 205 }, (_, i) => cohort({ id: `c-${i}`, name: `Cohort ${i}`, modifiedDatetime: at(i) }));
    const { saved } = toCohortContext(available[0], available);
    expect(MAX_SAVED_COHORTS).toBe(200);
    expect(saved).toHaveLength(200);
    const ids = saved.map((s) => s.id);
    // The store's order is kept: the active one, then the 199 newest; the five oldest others are left out.
    expect(ids.slice(0, 2)).toEqual(['c-0', 'c-6']);
    expect(ids.at(-1)).toBe('c-204');
    for (const id of ['c-1', 'c-2', 'c-3', 'c-4', 'c-5']) expect(ids).not.toContain(id);
    // At or under the cap, every cohort goes as it is.
    expect(toCohortContext(available[0], available.slice(0, 200)).saved).toHaveLength(200);
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
