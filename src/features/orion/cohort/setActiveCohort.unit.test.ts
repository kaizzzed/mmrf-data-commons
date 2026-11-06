import { selectCurrentCohortId } from '@gen3/core';
import { createTestCohortStore } from '../testing';
import { ALL_CASES_SHA256, storedCohortSha256 } from './cohortPort';
import { allCasesCohort, SetActiveCohortError, setActiveCohort } from './setActiveCohort';
import { createWriteLog } from './writeLog';

const THREAD = 'a'.repeat(32);
const BLACK = {
  mode: 'and' as const,
  root: { 'demographic.race': { operator: 'includes', field: 'demographic.race', operands: ['black or african american'] } },
};

const setup = () => {
  const store = createTestCohortStore(
    [
      { id: 'c-all', name: 'Cohort' },
      { id: 'c-black', name: 'Black patients', filters: BLACK, caseCount: 334 },
    ],
    'c-black',
  );
  const log = createWriteLog(() => undefined);
  return { store, log, current: () => selectCurrentCohortId(store.state()) };
};

describe('setActiveCohort (set_active_cohort)', () => {
  it('switches after an existence check and logs the write with its ids', () => {
    const { store, log, current } = setup();
    const outcome = setActiveCohort(
      store.port,
      { cohortId: 'c-all', name: 'Cohort', origin: 'scope_chip' },
      { threadId: THREAD, runId: null, stepId: null },
      log,
    );
    expect(outcome.changed).toBe(true);
    expect(outcome.result).toEqual({ cohortId: 'c-all', previousCohortId: 'c-black', undone: false });
    expect(current()).toBe('c-all');
    expect(log.entries()).toEqual([
      expect.objectContaining({
        action: 'set_active_cohort',
        threadId: THREAD,
        runId: null,
        stepId: null,
        outcome: 'activated',
        cohortId: 'c-all',
        detail: 'scope_chip',
      }),
    ]);
  });

  it('undoes once, back to the previous cohort, and logs the undo', () => {
    const { store, log, current } = setup();
    const outcome = setActiveCohort(store.port, { cohortId: 'c-all', name: 'Cohort', origin: 'make_active_and_open' }, { threadId: THREAD, runId: 'r', stepId: null }, log);
    expect(outcome.undo()).toBe(true);
    expect(current()).toBe('c-black');
    expect(outcome.result.undone).toBe(true);
    expect(outcome.undo()).toBe(false);
    expect(log.entries().map((e) => e.outcome)).toEqual(['activated', 'undone']);
  });

  it('leaves a later switch alone: undo applies only while its own switch is in force', () => {
    const { store, log, current } = setup();
    const outcome = setActiveCohort(store.port, { cohortId: 'c-all', name: 'Cohort', origin: 'scope_chip' }, { threadId: THREAD, runId: null, stepId: null }, log);
    store.port.setCurrent('c-black');
    store.port.setCurrent('c-all');
    store.port.setCurrent('c-black');
    expect(outcome.undo()).toBe(false);
    expect(current()).toBe('c-black');
  });

  it('refuses a cohort that is no longer in the list, and changes nothing', () => {
    const { store, log, current } = setup();
    expect(() =>
      setActiveCohort(store.port, { cohortId: 'c-gone', name: 'Gone', origin: 'scope_chip' }, { threadId: THREAD, runId: null, stepId: null }, log),
    ).toThrow(SetActiveCohortError);
    expect(current()).toBe('c-black');
    expect(log.entries()).toEqual([]);
  });

  it('writes nothing when the cohort is already active', () => {
    const { store, log } = setup();
    const outcome = setActiveCohort(store.port, { cohortId: 'c-black', name: 'Black patients', origin: 'scope_chip' }, { threadId: THREAD, runId: null, stepId: null }, log);
    expect(outcome.changed).toBe(false);
    expect(outcome.undo()).toBe(false);
    expect(log.entries()).toEqual([]);
  });

  it('makes all cases active through an unfiltered saved cohort, or says there is none', () => {
    const { store, log, current } = setup();
    expect(allCasesCohort(store.port)?.id).toBe('c-all');
    expect(storedCohortSha256({ id: 'x', name: 'x', filters: {} })).toBe(ALL_CASES_SHA256);
    setActiveCohort(store.port, { cohortId: null, name: 'All cases', origin: 'scope_chip' }, { threadId: THREAD, runId: null, stepId: null }, log);
    expect(current()).toBe('c-all');

    const filteredOnly = createTestCohortStore([{ id: 'c-black', name: 'Black patients', filters: BLACK }]);
    expect(() =>
      setActiveCohort(filteredOnly.port, { cohortId: null, name: 'All cases', origin: 'scope_chip' }, { threadId: THREAD, runId: null, stepId: null }, log),
    ).toThrow('No saved cohort covers all cases');
  });

  it('never treats a cohort that filters another index as all cases', () => {
    expect(
      storedCohortSha256({
        id: 'x',
        name: 'x',
        filters: { file: { mode: 'and', root: { data_type: { operator: 'includes', field: 'data_type', operands: ['vcf'] } } } },
      }),
    ).toBeNull();
  });
});
