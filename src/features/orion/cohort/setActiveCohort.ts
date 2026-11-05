// The set_active_cohort client action (TOOLS.md 4): a write, run only from a click, after an
// existence check, with undo. Logged with the thread, run and step ids.

import { ALL_CASES_SHA256, storedCohortSha256, type CohortPort, type StoredCohort } from './cohortPort';
import type { WriteLog } from './writeLog';

export type SetActiveOrigin = 'scope_chip' | 'make_active_and_open' | 'confirm_make_active';

export interface SetActiveRequest {
  /** The cohort to make active; null for all cases. */
  cohortId: string | null;
  /** Shown in the undo toast. */
  name: string;
  origin: SetActiveOrigin;
}

export interface SetActiveContext {
  threadId: string;
  runId: string | null;
  stepId: string | null;
}

export interface SetActiveResult {
  cohortId: string | null;
  previousCohortId: string | null;
  undone: boolean;
}

export interface SetActiveOutcome {
  result: SetActiveResult;
  /** False when the cohort was already active, so nothing was written and there is nothing to undo. */
  changed: boolean;
  /** Restores the previous active cohort if it still exists; false when it cannot. */
  undo(): boolean;
}

export type SetActiveErrorCode = 'NOT_FOUND' | 'NO_ALL_CASES_COHORT';

export class SetActiveCohortError extends Error {
  readonly code: SetActiveErrorCode;
  constructor(code: SetActiveErrorCode, message: string) {
    super(message);
    this.name = 'SetActiveCohortError';
    this.code = code;
  }
}

/** The saved cohort that stands for all cases: one with no filters. */
export const allCasesCohort = (port: CohortPort): StoredCohort | null => {
  const current = port.currentId();
  const unfiltered = port.list().filter((c) => storedCohortSha256(c) === ALL_CASES_SHA256);
  return unfiltered.find((c) => c.id === current) ?? unfiltered[0] ?? null;
};

export const setActiveCohort = (
  port: CohortPort,
  request: SetActiveRequest,
  context: SetActiveContext,
  log: WriteLog,
): SetActiveOutcome => {
  const target = request.cohortId === null ? allCasesCohort(port) : port.get(request.cohortId);
  if (!target) {
    throw request.cohortId === null
      ? new SetActiveCohortError('NO_ALL_CASES_COHORT', 'No saved cohort covers all cases, so there is none to make active')
      : new SetActiveCohortError('NOT_FOUND', `${request.name} is no longer in the cohort list`);
  }
  const previousCohortId = port.currentId();
  const result: SetActiveResult = { cohortId: target.id, previousCohortId, undone: false };
  if (previousCohortId === target.id) {
    return { result, changed: false, undo: () => false };
  }
  port.setCurrent(target.id);
  log.record({
    action: 'set_active_cohort',
    ...context,
    outcome: 'activated',
    cohortId: target.id,
    detail: request.origin,
  });
  let undone = false;
  return {
    result,
    changed: true,
    undo: () => {
      if (undone || previousCohortId === null || !port.get(previousCohortId)) return false;
      // Undo only while the switch is still in force: a later switch is the researcher's own.
      if (port.currentId() !== target.id) return false;
      port.setCurrent(previousCohortId);
      undone = true;
      result.undone = true;
      log.record({
        action: 'set_active_cohort',
        ...context,
        outcome: 'undone',
        cohortId: previousCohortId,
        detail: request.origin,
      });
      return true;
    },
  };
};
