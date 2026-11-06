import { selectAvailableCohorts, selectCurrentCohortId } from '@gen3/core';
import type { SaveCohortsArgs } from '../agui/types';
import { createTestCohortStore, streamEvents } from '../testing';
import { filterSetForDefinition, filterSetSha256 } from './cohortDef';
import { dontSaveAction, SaveCohortsError, saveCohorts } from './saveCohorts';
import { ledgerProgress, memoryLedgerStore } from './saveLedger';
import { createWriteLog } from './writeLog';

const THREAD = 'a'.repeat(32);
const RUN = 'fcaafc' + '0'.repeat(26);

/** The J3 pause's save_cohorts args: two case-ID cohorts, control (kras_wt) first. */
const J3_ARGS = JSON.parse(
  streamEvents('j3-save-pause')
    .flatMap((e) => (e.type === 'TOOL_CALL_ARGS' ? [e.delta] : []))
    .join(''),
) as SaveCohortsArgs;

const ALL_CASES = { id: 'c-all', name: 'Cohort' };

const setup = (extra: Parameters<typeof createTestCohortStore>[0] = []) => {
  const store = createTestCohortStore([ALL_CASES, ...extra], ALL_CASES.id);
  const ledger = memoryLedgerStore();
  const sink = jest.fn();
  const log = createWriteLog(sink, () => new Date('2026-11-05T12:00:00.000Z'));
  const save = (makeActive: string | null = null, args: SaveCohortsArgs = J3_ARGS) =>
    saveCohorts({ args, makeActive, threadId: THREAD, runId: RUN }, { port: store.port, ledger, log });
  const names = () => selectAvailableCohorts(store.state()).map((c) => c.name).sort();
  return { store, ledger, log, sink, save, names };
};

describe('saveCohorts (save_cohorts)', () => {
  it('creates each cohort with createNewCohort, finds it by id diff and reads back id, name and hash', () => {
    const { store, save, names, ledger } = setup();
    const result = save();
    expect(names()).toEqual(['Cohort', 'KRAS mutated (ORION)', 'KRAS not detected (ORION)']);
    expect(result.created).toHaveLength(2);
    expect(result.reused).toEqual([]);
    expect(result.confirm).toEqual({
      action: 'confirm',
      nonce: J3_ARGS.nonce,
      decision: 'create',
      makeActive: null,
      saved: J3_ARGS.cohorts.map((c, i) => ({
        ref: c.ref,
        cohortId: result.created[i],
        name: c.name,
        defSha256: c.defSha256,
        reused: false,
      })),
    });
    // The store holds the case-list FilterSet the contract names, and its hash is the pending one.
    const stored = store.port.get(result.created[0]);
    expect(stored?.filters.case_centric).toEqual(filterSetForDefinition(J3_ARGS.cohorts[0].definition));
    expect(filterSetSha256(stored?.filters.case_centric)).toBe(J3_ARGS.cohorts[0].defSha256);
    // Counts refresh the way the cohort bar's do, and the active cohort does not change.
    expect(store.refreshed).toEqual(result.created);
    expect(store.thunks).toHaveLength(2);
    expect(selectCurrentCohortId(store.state())).toBe(ALL_CASES.id);
    expect(ledgerProgress(ledger.read(J3_ARGS.nonce))).toEqual({ saved: 2, total: 2 });
  });

  it('logs every write with its thread, run and step ids', () => {
    const { save, log, sink } = setup();
    const result = save();
    expect(log.entries()).toEqual(
      J3_ARGS.cohorts.map((c, i) => ({
        at: '2026-11-05T12:00:00.000Z',
        action: 'save_cohorts',
        threadId: THREAD,
        runId: RUN,
        stepId: 's8',
        outcome: 'created',
        cohortId: result.created[i],
        detail: c.ref,
      })),
    );
    expect(sink).toHaveBeenCalledTimes(2);
  });

  it('reuses a saved cohort with the same defSha256 instead of saving it again', () => {
    const existing = {
      id: 'c-wt',
      name: 'KRAS wild type',
      filters: filterSetForDefinition(J3_ARGS.cohorts[0].definition),
    };
    const { save, names, store } = setup([existing]);
    const result = save();
    expect(result.reused).toEqual(['c-wt']);
    expect(result.created).toHaveLength(1);
    expect(result.confirm.saved[0]).toEqual({
      ref: 'kras_wt',
      cohortId: 'c-wt',
      name: 'KRAS wild type',
      defSha256: J3_ARGS.cohorts[0].defSha256,
      reused: true,
    });
    expect(names()).toEqual(['Cohort', 'KRAS mutated (ORION)', 'KRAS wild type']);
    expect(store.refreshed).toEqual(result.created);
  });

  it('prefers the reuse match the agent named when several cohorts match', () => {
    const filters = filterSetForDefinition(J3_ARGS.cohorts[1].definition);
    const { save } = setup([
      { id: 'c-first', name: 'First', filters },
      { id: 'c-named', name: 'Named', filters },
    ]);
    const args: SaveCohortsArgs = {
      ...J3_ARGS,
      cohorts: [J3_ARGS.cohorts[0], { ...J3_ARGS.cohorts[1], reuse: { cohortId: 'c-named', name: 'Named' } }],
    };
    expect(save(null, args).confirm.saved[1]).toMatchObject({ cohortId: 'c-named', reused: true });
  });

  it('reads back a null hash when the store holds filters ORION cannot read (WRITE_VERIFY_FAILED)', () => {
    const { store, ledger, log } = setup();
    const unreadable = {
      mode: 'or' as const,
      root: {
        'demographic.race': { operator: 'includes', field: 'demographic.race', operands: ['white'] },
        'diagnoses.iss_stage': { operator: 'includes', field: 'diagnoses.iss_stage', operands: ['Stage I'] },
      },
    };
    const port = {
      ...store.port,
      get: (id: string) => {
        const cohort = store.port.get(id);
        return cohort && { ...cohort, filters: { ...cohort.filters, case_centric: unreadable } };
      },
    };
    const result = saveCohorts({ args: J3_ARGS, makeActive: null, threadId: THREAD, runId: RUN }, { port, ledger, log });
    expect(result.confirm.saved.map((s) => s.defSha256)).toEqual([null, null]);
    expect(result.confirm.saved.map((s) => s.ref)).toEqual(['kras_wt', 'kras_mut']);
  });

  it('reads back the unique name createNewCohort gives a clashing one', () => {
    const { save } = setup([{ id: 'c-clash', name: 'kras mutated (orion)', filters: { mode: 'and', root: {} } }]);
    const result = save();
    // The clash is the unfiltered cohort, so it is not a reuse match: the new cohort is renamed.
    expect(result.confirm.saved[1]).toMatchObject({ ref: 'kras_mut', name: 'KRAS mutated (ORION) (1)', reused: false });
  });

  it('creates nothing more when Create is sent again for the same nonce (E19)', () => {
    const { save, names, store } = setup();
    const first = save();
    const again = save();
    expect(names()).toHaveLength(3);
    expect(again.created).toEqual([]);
    expect(again.confirm.saved).toEqual(first.confirm.saved);
    expect(store.refreshed).toHaveLength(2);
  });

  it('resumes a save cut short: only the cohorts missing from the ledger are created (C-25)', () => {
    const { save, store, ledger, names } = setup();
    // The store refuses the second cohort, as a tab closing mid-save would leave it.
    const createOnce = store.port.create;
    let calls = 0;
    store.port.create = (name, filters) => {
      calls += 1;
      if (calls === 2) throw new Error('the tab closed');
      createOnce(name, filters);
    };
    expect(() => save()).toThrow('the tab closed');
    expect(ledgerProgress(ledger.read(J3_ARGS.nonce))).toEqual({ saved: 1, total: 2 });
    expect(names()).toEqual(['Cohort', 'KRAS not detected (ORION)']);

    store.port.create = createOnce;
    const resumed = save();
    expect(resumed.created).toHaveLength(1);
    expect(names()).toEqual(['Cohort', 'KRAS mutated (ORION)', 'KRAS not detected (ORION)']);
    expect(resumed.confirm.saved.map((s) => s.reused)).toEqual([false, false]);
  });

  it('creates a ledger cohort again when it was deleted from the store since', () => {
    const { save, store } = setup();
    const first = save();
    store.remove(first.created[0]);
    const again = save();
    expect(again.created).toHaveLength(1);
    expect(again.created[0]).not.toBe(first.created[0]);
    expect(store.port.get(again.created[0])?.name).toBe('KRAS not detected (ORION)');
    expect(again.confirm.saved[1].cohortId).toBe(first.created[1]);
  });

  it('switches the active cohort for the ticked one, inside the same click, with undo', () => {
    const { save, store, log } = setup();
    const result = save('kras_mut');
    const mutId = result.confirm.saved[1].cohortId;
    expect(result.confirm.makeActive).toBe('kras_mut');
    expect(selectCurrentCohortId(store.state())).toBe(mutId);
    expect(log.entries().at(-1)).toMatchObject({
      action: 'set_active_cohort',
      outcome: 'activated',
      cohortId: mutId,
      runId: RUN,
      stepId: 's8',
      detail: 'confirm_make_active',
    });
    expect(result.activated?.undo()).toBe(true);
    expect(selectCurrentCohortId(store.state())).toBe(ALL_CASES.id);
    expect(result.activated?.undo()).toBe(false);
  });

  it('fails when the store adds no cohort, sending nothing, and the retry creates it', () => {
    const { save, store, names } = setup();
    store.failNextCreate();
    expect(() => save()).toThrow(SaveCohortsError);
    expect(names()).toEqual(['Cohort']);
    expect(save().created).toHaveLength(2);
  });

  it('refuses a request without definitions or with an unknown make-active ref', () => {
    const { save } = setup();
    const trimmed = { ...J3_ARGS, cohorts: J3_ARGS.cohorts.map((c) => ({ ...c, definition: null })) } as unknown as SaveCohortsArgs;
    expect(() => save(null, trimmed)).toThrow('A cohort definition is missing');
    expect(() => save('nope')).toThrow('nope is not one of the cohorts to save');
  });

  it('sends Don\'t save with no cohorts and no make-active', () => {
    expect(dontSaveAction('n'.repeat(32))).toEqual({
      action: 'confirm',
      nonce: 'n'.repeat(32),
      decision: 'dont_save',
      saved: [],
      makeActive: null,
    });
  });
});
