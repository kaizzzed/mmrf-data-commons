import { createContext, useContext } from 'react';
import type { RunState } from '../agui/reducer';
import type { AppId, ConfirmPending, FollowUp, OpenLink, VizReport, VizSpec } from '../agui/types';
import type { PlanEdit, ScopeOption } from '../cards/PlanEdits';
import type { SaveProgress } from '../cohort/saveLedger';
import type { InspectorTarget } from '../inspector/EvidenceInspector';

/** The state of a confirmation card's save, kept per nonce. */
export interface SaveState {
  progress: SaveProgress | null;
  saving: boolean;
  error: string | null;
}

/**
 * Everything a run's cards can do, provided once by the Assistant. Writes (Create, a hand-off's
 * make-active) run inside these click handlers; nothing here runs without a click.
 */
export interface RunActions {
  threadId: string;
  /** The thread's latest run: Retry step and edits apply to it only. */
  latestRunId: string | null;
  /** The run whose turn is in flight on this thread: its cards wait. */
  busyRunId: string | null;
  /** Read when a waiting card appears: typed text keeps focus in the composer (E21). */
  composerHasText: () => boolean;
  scopeOptions: readonly ScopeOption[];
  askFollowUp: (followUp: FollowUp) => void;
  clarify: (run: RunState, optionId: string) => void;
  cancel: (run: RunState) => void;
  consent: (run: RunState, accept: boolean) => void;
  create: (run: RunState, pending: ConfirmPending, makeActive: string | null) => void;
  dontSave: (run: RunState, pending: ConfirmPending) => void;
  edit: (run: RunState, edit: PlanEdit) => void;
  retry: (run: RunState, stepId: string) => void;
  inspect: (target: InspectorTarget) => void;
  /** Hand-off on the cohorts `cohortRefs` name (a limitation card: the run's scope). */
  openOnCohort: (run: RunState, appId: AppId, cohortRefs: readonly string[]) => void;
  /** A viz card's hand-off: the card names its cohort. */
  openInTool: (run: RunState, spec: VizSpec, appId: AppId, cohortId: string | null) => void;
  openLink: (link: OpenLink) => void;
  reportViz: (report: VizReport) => void;
  loadUntrimmedSpec: (runId: string, vizId: string) => Promise<VizSpec | null>;
  saveState: (nonce: string) => SaveState;
}

const noop = () => undefined;

/** What cards get with no Assistant around them: nothing acts. */
export const INERT_ACTIONS: RunActions = {
  threadId: '',
  latestRunId: null,
  busyRunId: null,
  composerHasText: () => false,
  scopeOptions: [],
  askFollowUp: noop,
  clarify: noop,
  cancel: noop,
  consent: noop,
  create: noop,
  dontSave: noop,
  edit: noop,
  retry: noop,
  inspect: noop,
  openOnCohort: noop,
  openInTool: noop,
  openLink: noop,
  reportViz: noop,
  loadUntrimmedSpec: () => Promise.resolve(null),
  saveState: () => ({ progress: null, saving: false, error: null }),
};

export const RunActionsContext = createContext<RunActions>(INERT_ACTIONS);

export const useRunActions = (): RunActions => useContext(RunActionsContext);
