import type { CallRecord, RunView } from './agui/types';

/** The plan version and step whose calls produced a step's result: itself, or the step a Reused one reuses. */
export interface CallOrigin {
  planVersion: number;
  stepId: string;
}

/** A step's call origin in the view's current plan (contract "Run record": a Reused step's calls are its reusedFrom's). */
export const callOrigin = (view: Pick<RunView, 'steps' | 'plan'>, stepId: string): CallOrigin =>
  view.steps.find((s) => s.id === stepId)?.reusedFrom ?? { planVersion: view.plan?.version ?? 1, stepId };

/** The record's calls of that origin, every attempt, in record order. */
export const callsOf = (calls: readonly CallRecord[], origin: CallOrigin): CallRecord[] =>
  calls.filter((c) => c.planVersion === origin.planVersion && c.stepId === origin.stepId);
