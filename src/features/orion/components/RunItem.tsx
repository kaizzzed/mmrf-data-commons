import React from 'react';
import { LuUnlink } from 'react-icons/lu';
import { isEndStatus, type RunState } from '../agui/reducer';
import type { RunStatus } from '../agui/types';
import { AnswerCard } from '../cards/AnswerCard';
import { FailedCard } from '../cards/FailedCard';
import { LimitationCard } from '../cards/LimitationCard';
import { PlanCard } from '../cards/PlanCard';
import { VizCardPlaceholder } from '../cards/VizCardPlaceholder';

const ANSWER_STATUSES: ReadonlySet<RunStatus> = new Set([
  'Answering',
  'Complete',
  'Partial',
  'ObservedOnly',
]);

export interface RunItemProps {
  run: RunState;
  /** Opens a catalog app on the active cohort, from an Unsupported card. */
  onOpenApp: (appId: string) => void;
}

/** One question and everything its run has shown so far, top to bottom. */
export const RunItem = ({ run, onOpenApp }: RunItemProps) => {
  const { view, status } = run;
  const limited = status === 'Limited' || status === 'Unsupported';
  const showAnswer =
    !!view && !limited && (ANSWER_STATUSES.has(status) || view.observed.length > 0);

  return (
    <article aria-label={run.question || 'Run'} className="flex flex-col gap-3">
      <p className="self-end max-w-[85%] whitespace-pre-wrap rounded-lg bg-base-lightest px-3 py-2 text-sm">
        {run.question}
      </p>
      <PlanCard status={status} plan={view?.plan ?? null} steps={view?.steps ?? []} />
      {view?.vizSpecs.map((spec) => <VizCardPlaceholder key={spec.vizId} spec={spec} />)}
      {showAnswer && view && <AnswerCard status={status} view={view} />}
      {status === 'Limited' && <LimitationCard limitations={view?.limitations ?? []} />}
      {status === 'Unsupported' && (
        <LimitationCard
          variant="unsupported"
          limitations={view?.limitations ?? []}
          onOpenOnCohort={onOpenApp}
        />
      )}
      {status === 'Failed' && <FailedCard code={run.code} message={run.errorMessage} />}
      {status === 'Interrupted' && (
        <p role="note" className="inline-flex flex-wrap items-center gap-1 text-sm">
          <LuUnlink aria-hidden focusable="false" />
          ORION lost this run before it finished. Rows that finished are kept as a partial
          result; ask again to rerun it.
          {run.code && <span className="font-mono text-xs">{run.code}</span>}
        </p>
      )}
      {run.transportError && !isEndStatus(status) && (
        <p role="note" className="inline-flex items-center gap-1 text-sm">
          <LuUnlink aria-hidden focusable="false" />
          Connection lost ({run.transportError.message}). The run may still finish on the
          server.
        </p>
      )}
    </article>
  );
};
