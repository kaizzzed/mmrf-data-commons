// The save_cohorts client action (contract "save_cohorts tool call", TOOLS.md 4): runs inside the
// Create click, writes cohorts to the platform's store and returns the confirm action with the
// read-back of every pending cohort. It never retries on its own (client writes never retry).

import type { CanonicalDefinition, OrionAction, SaveCohortsArgs, SavedCohortReadBack } from '../agui/types';
import { filterSetForDefinition } from './cohortDef';
import { storedCohortSha256, type CohortPort, type StoredCohort } from './cohortPort';
import type { LedgerCohort, LedgerStore, SaveLedger } from './saveLedger';
import { setActiveCohort, type SetActiveOutcome } from './setActiveCohort';
import type { WriteLog } from './writeLog';
import { sha256Hex } from './sha256';

export type ConfirmAction = Extract<OrionAction, { action: 'confirm' }>;

export type SaveErrorCode = 'NO_DEFINITION' | 'CREATE_FAILED' | 'READ_BACK_MISSING' | 'BAD_MAKE_ACTIVE';

export class SaveCohortsError extends Error {
  readonly code: SaveErrorCode;
  constructor(code: SaveErrorCode, message: string) {
    super(message);
    this.name = 'SaveCohortsError';
    this.code = code;
  }
}

export interface SaveCohortsRequest {
  args: SaveCohortsArgs;
  /** The ref ticked make-active on the card, or null. */
  makeActive: string | null;
  threadId: string;
  runId: string;
}

export interface SaveCohortsDeps {
  port: CohortPort;
  ledger: LedgerStore;
  log: WriteLog;
  now?: () => Date;
}

export interface SaveCohortsResult {
  confirm: ConfirmAction;
  created: string[];
  reused: string[];
  /** The make-active switch, with its undo; null when none was ticked or it changed nothing. */
  activated: SetActiveOutcome | null;
}

const hasDefinition = (
  cohort: SaveCohortsArgs['cohorts'][number],
): cohort is SaveCohortsArgs['cohorts'][number] & { definition: CanonicalDefinition } => cohort.definition !== null;

/**
 * The hash a saved cohort's stored filters read back as. Filters ORION cannot read (the store
 * changed them) still yield a hash, of their raw JSON, so the agent's read-back check fails the
 * write step with WRITE_VERIFY_FAILED instead of the run waiting on a confirm that never comes.
 */
const readBackSha256 = (cohort: StoredCohort): string =>
  storedCohortSha256(cohort) ?? sha256Hex(`unreadable:${JSON.stringify(cohort.filters)}`);

/** Which cohort, if any, already holds a definition: the agent's match first, then the store's order. */
const findReuse = (
  port: CohortPort,
  defSha256: string,
  preferredId: string | null,
): StoredCohort | null => {
  const matches = port.list().filter((c) => storedCohortSha256(c) === defSha256);
  return matches.find((c) => c.id === preferredId) ?? matches[0] ?? null;
};

/** One cohort created; createNewCohort returns no id, so the new one is found by diffing ids. */
const createCohort = (port: CohortPort, name: string, definition: CanonicalDefinition): StoredCohort => {
  const before = new Set(port.list().map((c) => c.id));
  port.create(name, filterSetForDefinition(definition));
  const added = port.list().filter((c) => !before.has(c.id));
  if (added.length !== 1) {
    throw new SaveCohortsError(
      'CREATE_FAILED',
      `Saving ${name} added ${added.length} cohorts to the cohort list instead of one`,
    );
  }
  return added[0];
};

export const saveCohorts = (request: SaveCohortsRequest, deps: SaveCohortsDeps): SaveCohortsResult => {
  const { args, makeActive, threadId, runId } = request;
  const { port, log } = deps;
  const now = deps.now ?? (() => new Date());
  const pending = args.cohorts;
  if (!pending.every(hasDefinition)) {
    throw new SaveCohortsError('NO_DEFINITION', 'A cohort definition is missing from the save request');
  }
  if (makeActive !== null && !pending.some((c) => c.ref === makeActive)) {
    throw new SaveCohortsError('BAD_MAKE_ACTIVE', `${makeActive} is not one of the cohorts to save`);
  }

  const at = now().toISOString();
  const previous = deps.ledger.read(args.nonce);
  const ledger: SaveLedger = {
    nonce: args.nonce,
    threadId,
    runId,
    stepId: args.stepId,
    planSignature: args.planSignature,
    planVersion: args.planVersion,
    createdAt: previous?.createdAt ?? at,
    updatedAt: at,
    confirmSentAt: previous?.confirmSentAt ?? null,
    cohorts: pending.map(
      (c): LedgerCohort =>
        previous?.cohorts.find((p) => p.ref === c.ref && p.defSha256 === c.defSha256) ?? {
          ref: c.ref,
          name: c.name,
          defSha256: c.defSha256,
          cohortId: null,
          savedName: null,
          reused: false,
        },
    ),
  };
  // Written before anything is created, so a save cut short is resumed, never repeated.
  deps.ledger.write(ledger);

  const created: string[] = [];
  const reusedIds: string[] = [];
  const entry = (ref: string): LedgerCohort => {
    const found = ledger.cohorts.find((c) => c.ref === ref);
    if (!found) throw new Error(`ledger lost ${ref}`);
    return found;
  };
  const writeEntry = (ref: string, patch: Partial<LedgerCohort>): void => {
    Object.assign(entry(ref), patch);
    ledger.updatedAt = now().toISOString();
    deps.ledger.write(ledger);
  };

  for (const cohort of pending) {
    const recorded = entry(cohort.ref);
    const kept = recorded.cohortId ? port.get(recorded.cohortId) : null;
    if (kept && storedCohortSha256(kept) === cohort.defSha256) {
      // Saved by an earlier Create of this nonce (E19): nothing to create.
      if (recorded.savedName !== kept.name) writeEntry(cohort.ref, { savedName: kept.name });
      continue;
    }
    const match = findReuse(port, cohort.defSha256, cohort.reuse?.cohortId ?? null);
    if (match) {
      writeEntry(cohort.ref, { cohortId: match.id, savedName: match.name, reused: true });
      reusedIds.push(match.id);
      log.record({
        action: 'save_cohorts',
        threadId,
        runId,
        stepId: args.stepId,
        outcome: 'reused',
        cohortId: match.id,
        detail: cohort.ref,
      });
      continue;
    }
    let saved: StoredCohort;
    try {
      saved = createCohort(port, cohort.name, cohort.definition);
    } catch (err) {
      log.record({
        action: 'save_cohorts',
        threadId,
        runId,
        stepId: args.stepId,
        outcome: 'failed',
        cohortId: null,
        detail: `${cohort.ref}: ${err instanceof Error ? err.message : 'create failed'}`,
      });
      throw err;
    }
    writeEntry(cohort.ref, { cohortId: saved.id, savedName: saved.name, reused: false });
    created.push(saved.id);
    log.record({
      action: 'save_cohorts',
      threadId,
      runId,
      stepId: args.stepId,
      outcome: 'created',
      cohortId: saved.id,
      detail: cohort.ref,
    });
    port.refreshCount(saved.id);
  }

  // The read-back: id and name as the store now holds them, and the hash of what it stored.
  const saved: SavedCohortReadBack[] = pending.map((cohort) => {
    const recorded = entry(cohort.ref);
    const stored = recorded.cohortId ? port.get(recorded.cohortId) : null;
    if (!recorded.cohortId || !stored) {
      throw new SaveCohortsError('READ_BACK_MISSING', `${cohort.name} is not in the cohort list after saving`);
    }
    return {
      ref: cohort.ref,
      cohortId: stored.id,
      name: stored.name,
      defSha256: readBackSha256(stored),
      reused: recorded.reused,
    };
  });

  let activated: SetActiveOutcome | null = null;
  if (makeActive !== null) {
    const target = saved.find((s) => s.ref === makeActive);
    if (target) {
      activated = setActiveCohort(
        port,
        { cohortId: target.cohortId, name: target.name, origin: 'confirm_make_active' },
        { threadId, runId, stepId: args.stepId },
        log,
      );
    }
  }

  ledger.updatedAt = now().toISOString();
  ledger.confirmSentAt = ledger.updatedAt;
  deps.ledger.write(ledger);

  return {
    confirm: { action: 'confirm', nonce: args.nonce, decision: 'create', saved, makeActive },
    created,
    reused: reusedIds,
    activated: activated?.changed ? activated : null,
  };
};

/** The confirm a Don't save click sends: no write, so nothing is logged or stored. */
export const dontSaveAction = (nonce: string): ConfirmAction => ({
  action: 'confirm',
  nonce,
  decision: 'dont_save',
  saved: [],
  makeActive: null,
});
