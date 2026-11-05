import React, { useId } from 'react';
import type { Plan, PlanRow, RunStatus, Step, StepStatus } from '../agui/types';
import { RunStatusLabel, StepStatusLabel } from '../components/StatusLabel';
import { formatDuration, formatScope } from '../format';
import { Card } from './Card';
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
    return steps.every((s) => s.status === 'Skipped') ? 'Skipped' : 'Done';
  }
  return steps.some((s) => FINISHED.has(s.status)) ? 'Running' : 'Queued';
};

const rowDuration = (steps: readonly Step[]): string | null => {
  const timed = steps.filter((s) => s.durationMs !== null);
  if (timed.length === 0) return null;
  return formatDuration(timed.reduce((sum, s) => sum + (s.durationMs ?? 0), 0));
};

const PlanRowItem = ({ row, steps }: { row: PlanRow; steps: Step[] }) => {
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
        <span className="font-medium">Tool:</span>{' '}
        <span className="font-mono">{row.tool}</span> · {row.reason}
      </p>
      {steps.length > 0 && (
        <ul aria-label={`Steps in row ${row.row}`} className="flex flex-col gap-2 pl-2">
          {steps.map((step) => (
            <StepRow key={step.id} step={step} />
          ))}
        </ul>
      )}
    </li>
  );
};

/** Folded steps lead their row, as sub-rows above its own steps. */
const stepsForRow = (row: PlanRow, steps: readonly Step[]): Step[] => {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const rowSteps = row.stepIds
    .map((id) => byId.get(id))
    .filter((s): s is Step => s !== undefined);
  return [...rowSteps.filter((s) => s.folded), ...rowSteps.filter((s) => !s.folded)];
};

export interface PlanCardProps {
  status: RunStatus;
  plan: Plan | null;
  steps: Step[];
}

/** The plan as a live step list. The run's screen word sits in its header. */
export const PlanCard = ({ status, plan, steps }: PlanCardProps) => {
  const titleId = useId();
  return (
    <Card
      titleId={titleId}
      title={plan ? `Plan, version ${plan.version}` : 'Plan'}
      status={<RunStatusLabel status={status} className="text-sm font-medium" />}
    >
      {plan ? (
        <>
          <p className="text-sm font-medium">
            {formatScope(plan.scope.name, plan.scope.caseCount)}
          </p>
          <p className="text-sm">{plan.paraphrase}</p>
          <ol aria-label="Plan rows" className="flex flex-col gap-2">
            {plan.rows.map((row) => (
              <PlanRowItem key={row.row} row={row} steps={stepsForRow(row, steps)} />
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
        </>
      ) : (
        <p className="text-sm">The plan appears here before any tool runs.</p>
      )}
    </Card>
  );
};
