// "Open with this cohort" and "Open on this cohort" (C-06, C-11; contract "Hand-off"): the full
// tool opens in this tab, on the cohort its card or limitation is pinned to. When that cohort is
// not the active one, the switch is a set_active_cohort with undo, logged as a write, made inside
// the click. A cohort the researcher chose not to save (WRITE_SKIPPED) never opens (C-16).

import type { AppId, CohortView, RunView } from '../agui/types';
import type { CohortPort } from '../cohort/cohortPort';
import { SetActiveCohortError, setActiveCohort } from '../cohort/setActiveCohort';
import type { WriteLog } from '../cohort/writeLog';
import type { Notifier } from './notifier';

export const HANDOFF_SKIPPED_REASON = "You chose Don't save, so Open on this cohort is off.";

export interface HandoffTarget {
  /** The platform cohort to open on; null opens the tool with no cohort switch. */
  cohortId: string | null;
  cohortName: string | null;
  /** Set when the hand-off is off; the button stays, disabled, with this reason. */
  disabledReason: string | null;
}

/** The run cohorts behind `cohortRefs`, in order; unknown refs are left out. */
const pinned = (view: Pick<RunView, 'cohorts'>, cohortRefs: readonly string[]): CohortView[] =>
  cohortRefs.flatMap((ref) => view.cohorts.filter((c) => c.ref === ref));

/**
 * The cohort a hand-off opens on: the first pinned cohort with a platform id (saved, reused, or a
 * scope backed by a saved cohort). A skipped cohort turns the hand-off off.
 */
export const handoffTarget = (view: Pick<RunView, 'cohorts' | 'limitations'>, cohortRefs: readonly string[]): HandoffTarget => {
  const cohorts = pinned(view, cohortRefs);
  if (cohorts.some((c) => c.save === 'skipped')) {
    return {
      cohortId: null,
      cohortName: null,
      disabledReason: view.limitations.find((l) => l.code === 'WRITE_SKIPPED')?.text ?? HANDOFF_SKIPPED_REASON,
    };
  }
  const withId = cohorts.find((c) => c.cohortId !== null);
  return { cohortId: withId?.cohortId ?? null, cohortName: withId ? (withId.savedName ?? withId.name) : null, disabledReason: null };
};

export interface HandoffDeps {
  port: CohortPort;
  log: WriteLog;
  notify: Notifier;
  /** Same-tab navigation to `/?app=<appId>`. */
  navigate: (appId: AppId) => void;
}

export interface HandoffRequest {
  appId: AppId;
  cohortId: string | null;
  /** For the undo toast; the store's own name is used when it has the cohort. */
  cohortName?: string | null;
  threadId: string;
  runId: string;
}

/**
 * open_full_tool, preceded by set_active_cohort when the card's cohort is not the active one.
 * Returns false when nothing opened (the cohort is gone); the researcher is told why.
 */
export const openInTool = (deps: HandoffDeps, request: HandoffRequest): boolean => {
  const { port, log, notify, navigate } = deps;
  const { appId, cohortId, threadId, runId } = request;
  if (cohortId !== null && port.currentId() !== cohortId) {
    const name = port.get(cohortId)?.name ?? request.cohortName ?? 'The cohort';
    try {
      const outcome = setActiveCohort(
        port,
        { cohortId, name, origin: 'make_active_and_open' },
        { threadId, runId, stepId: null },
        log,
      );
      if (outcome.changed) notify.undo(`Active cohort: ${name}.`, outcome.undo);
    } catch (err) {
      if (!(err instanceof SetActiveCohortError)) throw err;
      notify.error(`${err.message}, so the tool did not open.`);
      return false;
    }
  }
  navigate(appId);
  return true;
};
