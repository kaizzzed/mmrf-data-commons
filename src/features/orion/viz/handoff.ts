// "Open with this cohort" (FR-14's Must part; F3 "How hand-off works"; contract "Hand-off") and
// the DEinput fallback's preconditions (C-16). Both read the run cohorts a card is pinned to.

import type { AppId, CohortView, DeMethod, PinnedViz, RunView, VizSpec } from '../agui/types';

/** The catalog titles (config/gen3/analysisTools.json) of the apps a viz card can open. */
export const APP_TITLES: Partial<Record<AppId, string>> = {
  Correlation: 'Correlation Plot',
  OncoMatrix: 'OncoMatrix',
  DE: 'Differential Gene Expression',
  CohortComparison: 'Cohort Comparison',
  GeneExpression: 'Gene Expression Clustering',
};

export const appTitle = (appId: AppId): string => APP_TITLES[appId] ?? appId;

export const OPEN_LABEL = 'Open with this cohort';
export const MAKE_ACTIVE_LABEL = 'Make active and open';

/** Used when the run carries no WRITE_SKIPPED limitation line to quote. */
export const WRITE_SKIPPED_REASON = "You chose Don't save, so Open with this cohort is off.";
export const NOT_SAVED_REASON = "This card's cohort is not saved, so the full tool cannot open on it.";
export const UNKNOWN_COHORT_REASON = "This card's cohort is not in the run, so the full tool cannot open on it.";

const DE_METHOD_LABELS: Record<DeMethod, string> = { wilcoxon: 'Wilcoxon', edgeR: 'edgeR', limma: 'limma' };

export interface Handoff {
  appId: AppId;
  /** The cohort the full tool opens on; null opens it with no cohort switch. */
  cohortId: string | null;
  label: typeof OPEN_LABEL | typeof MAKE_ACTIVE_LABEL;
  /** Set when the button is disabled; shown beside it. */
  disabledReason: string | null;
  /** The pinned cohorts' names, for the card's "Pinned to" line. */
  cohortNames: string[];
  /** What to set by hand in the full tool until FR-22 carries the card's settings. */
  settings: string[];
}

/** The run cohorts a card is pinned to, in its cohortRefs order; undefined for an unknown ref. */
export const pinnedCohorts = (spec: Pick<VizSpec, 'cohortRefs'>, run: Pick<RunView, 'cohorts'>): (CohortView | undefined)[] =>
  spec.cohortRefs.map((ref) => run.cohorts.find((c) => c.ref === ref));

const cohortName = (c: CohortView): string => c.savedName ?? c.name;

/** The WRITE_SKIPPED limitation's own line when the run has one. */
const writeSkippedReason = (run: Pick<RunView, 'limitations'>): string =>
  run.limitations.find((l) => l.code === 'WRITE_SKIPPED')?.text ?? WRITE_SKIPPED_REASON;

/** Whether a card is pinned to a cohort the researcher chose not to save (Don't save, C-16). */
export const pinnedToSkipped = (spec: Pick<VizSpec, 'cohortRefs'>, run: Pick<RunView, 'cohorts'>): boolean =>
  pinnedCohorts(spec, run).some((c) => c?.save === 'skipped');

/** The settings the full tool needs by hand, from the pinned inputs and the pinned cohorts. */
export const settingsToReapply = (pinned: PinnedViz | null, cohorts: readonly CohortView[]): string[] => {
  const scope = cohorts.length === 1 ? [`Cohort: ${cohortName(cohorts[0])}`] : [];
  if (!pinned) return scope;
  switch (pinned.kind) {
    case 'survival':
      return [...scope, `Survival variable: ${pinned.term}`, `Overlay: ${pinned.overlay}`];
    case 'oncomatrix':
      return [...scope, `Genes, in this order: ${pinned.genes.join(', ')}`];
    case 'deDirect': {
      const [control, kase] = pinned.groups;
      const lines = [`Groups: ${control.name} (control), then ${kase.name} (case)`, `Method: ${DE_METHOD_LABELS[pinned.method]}`];
      const v = pinned.volcano;
      if (v?.pValue !== undefined || v?.foldChangeCutoff !== undefined) {
        const parts = [
          v.pValue !== undefined ? `-log10 p cutoff ${v.pValue}${v.pValueType ? ` (${v.pValueType} p)` : ''}` : null,
          v.foldChangeCutoff !== undefined ? `log2FC cutoff ${v.foldChangeCutoff}` : null,
        ].filter((p): p is string => p !== null);
        lines.push(`Volcano: ${parts.join(', ')}`);
      }
      return lines;
    }
    case 'deInput': {
      const [control, kase] = pinned.groups;
      return [`Groups: ${control.name} (control), then ${kase.name} (case)`, 'Method: Wilcoxon'];
    }
  }
};

/**
 * The hand-off button for a card. A card pinned to one cohort opens on its cohortId (null for
 * all cases or an unsaved active cohort: no switch). A DE card's two saved groups need no
 * switch: the full tool picks them as groups, so it opens with no cohort. A skipped cohort
 * disables hand-off with the WRITE_SKIPPED reason; an unsaved planned cohort cannot be opened.
 * `activeCohortId` is the platform's current cohort when the host knows it (undefined otherwise):
 * opening on another cohort then reads "Make active and open".
 */
export const handoffFor = (
  spec: Pick<VizSpec, 'appId' | 'cohortRefs'>,
  pinned: PinnedViz | null,
  run: Pick<RunView, 'cohorts' | 'limitations'>,
  activeCohortId?: string | null,
): Handoff => {
  const found = pinnedCohorts(spec, run);
  const cohorts = found.filter((c): c is CohortView => c !== undefined);
  const base = {
    appId: spec.appId,
    cohortNames: cohorts.map(cohortName),
    settings: settingsToReapply(pinned, cohorts),
  };
  const disabled = (reason: string): Handoff => ({ ...base, cohortId: null, label: OPEN_LABEL, disabledReason: reason });

  if (cohorts.some((c) => c.save === 'skipped')) return disabled(writeSkippedReason(run));
  if (cohorts.length !== found.length || cohorts.length === 0) return disabled(UNKNOWN_COHORT_REASON);
  // A planned cohort exists on the platform only once saved or reused (its read-back id).
  if (cohorts.some((c) => c.role === 'planned' && c.cohortId === null)) return disabled(NOT_SAVED_REASON);

  const cohortId = cohorts.length === 1 ? cohorts[0].cohortId : null;
  const switches = cohortId !== null && activeCohortId !== undefined && cohortId !== activeCohortId;
  return { ...base, cohortId, label: switches ? MAKE_ACTIVE_LABEL : OPEN_LABEL, disabledReason: null };
};

export type DeFallback =
  | { available: true }
  | { available: false; reason: string };

/**
 * Whether a deDirect card may fall back to DEinput (cut 2): DEinput seeds its groups from saved
 * cohorts, so both groups must be saved or reused. After Don't save the fallback is off (C-16).
 */
export const deInputFallback = (
  spec: Pick<VizSpec, 'launcher' | 'cohortRefs'>,
  run: Pick<RunView, 'cohorts' | 'limitations'>,
): DeFallback => {
  if (spec.launcher !== 'deDirect') return { available: false, reason: 'Only a direct DE card falls back to DEinput.' };
  const cohorts = pinnedCohorts(spec, run);
  if (cohorts.some((c) => c?.save === 'skipped')) {
    return { available: false, reason: "You chose Don't save, so the DEinput fallback, which needs saved cohorts, is off." };
  }
  if (cohorts.length !== 2 || cohorts.some((c) => !c || c.cohortId === null)) {
    return { available: false, reason: 'The DEinput fallback needs both groups saved as cohorts.' };
  }
  return { available: true };
};
