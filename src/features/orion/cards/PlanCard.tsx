import React, { useId, useState } from 'react';
import { Button } from '@mantine/core';
import { LuArrowRightLeft } from 'react-icons/lu';
import type { Fact, Plan, PlanRow, PlanScope, RunStatus, RunView, Step, StepStatus } from '../agui/types';
import { RunStatusLabel, StepStatusLabel } from '../components/StatusLabel';
import { formatCount, formatDuration } from '../format';
import { Card } from './Card';
import { factMap, FactNumber, type FactLookup } from './FactChip';
import { PlanEdits, type PlanEdit, type ScopeOption } from './PlanEdits';
import { StepRow } from './StepRow';

const FINISHED: ReadonlySet<StepStatus> = new Set(['Done', 'Empty', 'Skipped', 'Reused']);

/** A row ticks off when all of its steps have; any failure or wait shows first. */
export const rowStatus = (steps: readonly Step[]): StepStatus => {
  const has = (status: StepStatus) => steps.some((s) => s.status === status);
  for (const status of ['Failed', 'Retrying', 'Running', 'AwaitingUser'] as const) {
    if (has(status)) return status;
  }
  if (steps.length > 0 && steps.every((s) => FINISHED.has(s.status))) {
    if (has('Empty')) return 'Empty';
    if (steps.every((s) => s.status === 'Skipped')) return 'Skipped';
    return steps.every((s) => s.status === 'Reused') ? 'Reused' : 'Done';
  }
  return steps.some((s) => FINISHED.has(s.status)) ? 'Running' : 'Queued';
};

const rowDuration = (steps: readonly Step[]): string | null => {
  const timed = steps.filter((s) => s.durationMs !== null);
  if (timed.length === 0) return null;
  return formatDuration(timed.reduce((sum, s) => sum + (s.durationMs ?? 0), 0));
};

/** Folded steps lead their row, as sub-rows above its own steps. */
export const stepsForRow = (row: PlanRow, steps: readonly Step[]): Step[] => {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const rowSteps = row.stepIds
    .map((id) => byId.get(id))
    .filter((s): s is Step => s !== undefined);
  return [...rowSteps.filter((s) => s.folded), ...rowSteps.filter((s) => !s.folded)];
};

const PlanRowItem = ({
  row,
  steps,
  canRetry,
  onRetry,
  onInspectStep,
}: {
  row: PlanRow;
  steps: Step[];
  canRetry: (step: Step) => boolean;
  onRetry?: (stepId: string) => void;
  onInspectStep?: (stepId: string) => void;
}) => {
  const status = rowStatus(steps);
  return (
    <li className="flex flex-col gap-1 border-t border-base-lighter pt-2 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-medium">
          {row.row}. {row.label}
        </span>
        <StepStatusLabel
          status={status}
          detail={status === 'Done' ? rowDuration(steps) : null}
          className="text-sm"
        />
      </div>
      <p className="text-xs">
        <span className="font-medium">Tool:</span> <span className="font-mono">{row.tool}</span> · {row.reason}
      </p>
      {/* The row-to-step map (C-15): chips and the Inspector name both, as "Row n · sN tool". */}
      <p className="text-xs">
        <span className="font-medium">Row {row.row} steps:</span>{' '}
        <span className="font-mono">{row.stepIds.join(', ')}</span>
      </p>
      {steps.length > 0 && (
        <ul aria-label={`Steps in row ${row.row}`} className="flex flex-col gap-2 pl-2">
          {steps.map((step) => (
            <StepRow
              key={step.id}
              step={step}
              onRetry={onRetry && canRetry(step) ? () => onRetry(step.id) : undefined}
              onInspect={onInspectStep ? () => onInspectStep(step.id) : undefined}
            />
          ))}
        </ul>
      )}
    </li>
  );
};

/** "Scope: <cohort name> · <n> cases", the count a chip once a step sized the scope (C-01, FR-09). */
const ScopeLine = ({
  prefix,
  scope,
  factId,
  facts,
  onCite,
}: {
  prefix: string;
  scope: PlanScope;
  factId: string | null;
  facts: FactLookup;
  onCite?: (factId: string) => void;
}) => (
  <p className="text-sm font-medium">
    {prefix}: {scope.name} ·{' '}
    {scope.caseCount === null ? (
      'count pending'
    ) : (
      <>
        <FactNumber value={scope.caseCount} factId={factId} facts={facts} onCite={onCite} />{' '}
        {scope.caseCount === 1 ? 'case' : 'cases'}
      </>
    )}
  </p>
);

export interface PlanCardProps {
  status: RunStatus;
  view: RunView | null;
  /** The plan takes an edit now: the run's status accepts edit_plan and it is the thread's latest run. */
  canEdit?: boolean;
  /** A turn for this run is in flight: edits wait. */
  busy?: boolean;
  /** Retry step applies to this step (a failed read of the latest Partial run). */
  canRetry?: (step: Step) => boolean;
  scopeOptions?: readonly ScopeOption[];
  onEdit?: (edit: PlanEdit) => void;
  onRetry?: (stepId: string) => void;
  onInspectStep?: (stepId: string) => void;
  onCite?: (factId: string) => void;
}

const NO_FACTS: readonly Fact[] = [];
const never = () => false;

/** The plan as a live step list. The run's screen word sits in its header; the scope line above row 1. */
export const PlanCard = ({
  status,
  view,
  canEdit = false,
  busy = false,
  canRetry = never,
  scopeOptions = [],
  onEdit,
  onRetry,
  onInspectStep,
  onCite,
}: PlanCardProps) => {
  const titleId = useId();
  const editsId = useId();
  const [editing, setEditing] = useState(false);
  const plan: Plan | null = view?.plan ?? null;
  const steps = view?.steps ?? [];
  const facts = factMap(view?.facts ?? NO_FACTS);
  const base = view?.cohorts.find((c) => c.ref === 'base');
  const editable = plan?.editable.filter((e) => e.field !== 'cohortName') ?? [];
  const superseded = view?.superseded ?? [];
  const editsOpen = editing && canEdit && !!onEdit;

  return (
    <Card
      titleId={titleId}
      title={plan ? `Plan, version ${plan.version}` : 'Plan'}
      status={<RunStatusLabel status={status} className="text-sm font-medium" />}
    >
      {plan ? (
        <>
          <ScopeLine prefix="Scope" scope={plan.scope} factId={base?.caseCountFactId ?? null} facts={facts} onCite={onCite} />
          {plan.altScope && (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span>
                Also named: {plan.altScope.name} ·{' '}
                {plan.altScope.caseCount === null
                  ? 'count pending'
                  : `${formatCount(plan.altScope.caseCount)} ${plan.altScope.caseCount === 1 ? 'case' : 'cases'}`}
              </span>
              {plan.altScopeChoice && onEdit && (
                <Button
                  type="button"
                  variant="outline"
                  radius="xl"
                  size="compact-sm"
                  disabled={!canEdit || busy}
                  leftSection={<LuArrowRightLeft aria-hidden focusable="false" />}
                  onClick={() => plan.altScopeChoice && onEdit({ field: 'scope', value: plan.altScopeChoice })}
                >
                  Switch scope to {plan.altScope.name}
                </Button>
              )}
            </div>
          )}
          <p className="text-sm">{plan.paraphrase}</p>
          {superseded.length > 0 && (
            <p className="text-sm">
              Replaces version {superseded.map((s) => s.planVersion).join(', ')}: an edit made this plan; finished
              steps whose inputs did not change are reused.
            </p>
          )}
          <ol aria-label="Plan rows" className="flex flex-col gap-2">
            {plan.rows.map((row) => (
              <PlanRowItem
                key={row.row}
                row={row}
                steps={stepsForRow(row, steps)}
                canRetry={canRetry}
                onRetry={onRetry}
                onInspectStep={onInspectStep}
              />
            ))}
          </ol>
          {plan.assumptions.length > 0 && (
            <div>
              <h4 className="text-sm font-semibold">Assumptions</h4>
              <ul className="list-disc pl-5 text-sm">
                {plan.assumptions.map((a, i) => (
                  <li key={`${a.code}-${i}`}>{a.text}</li>
                ))}
              </ul>
            </div>
          )}
          {editable.length > 0 && onEdit && (
            <div className="flex flex-col gap-2">
              <div>
                <Button
                  type="button"
                  variant="subtle"
                  size="compact-sm"
                  aria-expanded={editsOpen}
                  aria-controls={editsId}
                  disabled={!canEdit}
                  onClick={() => setEditing((open) => !open)}
                >
                  {editsOpen ? 'Close settings' : 'Edit settings'}
                </Button>
              </div>
              <div id={editsId} hidden={!editsOpen}>
                {editsOpen && (
                  <PlanEdits editable={editable} scopeOptions={scopeOptions} disabled={busy} onEdit={onEdit} />
                )}
              </div>
            </div>
          )}
        </>
      ) : (
        <p className="text-sm">
          {status === 'Planning' || status === 'Stopping'
            ? 'The plan appears here before any tool runs.'
            : 'No plan was made before the run ended.'}
        </p>
      )}
    </Card>
  );
};
