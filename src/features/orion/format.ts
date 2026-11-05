import type { Fact } from './agui/types';

export const formatDuration = (ms: number): string =>
  ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;

export const formatCount = (n: number): string => n.toLocaleString('en-US');

/** "Scope: <cohort name> · <n> cases", or "· count pending" before a count is known (chip and plan card). */
export const formatScope = (name: string, caseCount: number | null): string =>
  caseCount === null
    ? `Scope: ${name} · count pending`
    : `Scope: ${name} · ${formatCount(caseCount)} ${caseCount === 1 ? 'case' : 'cases'}`;

/** A citation chip names the plan row and the step, such as "Row 6 · s9 de_run". */
export const citationLabel = (fact: Pick<Fact, 'row' | 'stepId' | 'tool'>): string =>
  `Row ${fact.row} · ${fact.stepId} ${fact.tool}`;
