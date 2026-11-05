import React from 'react';
import { LuUnlink } from 'react-icons/lu';
import { isEndStatus, type RunState } from '../agui/reducer';
import { ACTION_STATUSES, type RunStatus, type Step } from '../agui/types';
import { AnswerCard } from '../cards/AnswerCard';
import { ClarificationCard } from '../cards/ClarificationCard';
import { ConfirmationCard } from '../cards/ConfirmationCard';
import { ConsentCard } from '../cards/ConsentCard';
import { FailedCard } from '../cards/FailedCard';
import { LimitationCard } from '../cards/LimitationCard';
import { PlanCard } from '../cards/PlanCard';
import { handoffTarget } from '../handoff/handoff';
import { VizCard } from '../viz/VizCard';
import { useRunActions } from './RunActions';

const ANSWER_STATUSES: ReadonlySet<RunStatus> = new Set(['Answering', 'Complete', 'Partial', 'ObservedOnly']);
const EDIT_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>(ACTION_STATUSES.edit_plan);
/** Statuses whose own card carries the run's word, so a plan card without a plan adds nothing. */
const NO_PLAN_CARD: ReadonlySet<RunStatus> = new Set(['Clarifying', 'Unsupported', 'Failed']);

export interface RunItemProps {
  run: RunState;
}

/** One question and everything its run has shown so far, top to bottom (F2). */
export const RunItem = ({ run }: RunItemProps) => {
  const actions = useRunActions();
  const { view, status } = run;
  const isLatest = actions.latestRunId === run.runId;
  const busy = actions.busyRunId === run.runId;
  const pending = view?.pending ?? null;
  const limited = status === 'Limited' || status === 'Unsupported';
  const showAnswer =
    !!view && status !== 'Unsupported' && (ANSWER_STATUSES.has(status) || view.observed.length > 0);
  const showPlan = !!view?.plan || !NO_PLAN_CARD.has(status);

  const cite = (factId: string) => {
    const fact = view?.facts.find((f) => f.id === factId);
    if (fact) actions.inspect({ runId: run.runId, stepId: fact.stepId, factId });
  };
  const inspectStep = (stepId: string) => actions.inspect({ runId: run.runId, stepId, factId: null });
  const canRetry = (step: Step) => isLatest && status === 'Partial' && step.status === 'Failed' && step.kind !== 'client';
  const handoff = view ? handoffTarget(view, ['base']) : null;

  return (
    <article aria-label={run.question || 'Run'} className="flex flex-col gap-3">
      <p className="self-end max-w-[85%] whitespace-pre-wrap rounded-lg bg-base-lightest px-3 py-2 text-sm">
        {run.question}
      </p>
      {showPlan && (
        <PlanCard
          status={status}
          view={view}
          canEdit={isLatest && EDIT_STATUSES.has(status)}
          busy={busy}
          canRetry={canRetry}
          scopeOptions={actions.scopeOptions}
          onEdit={(edit) => actions.edit(run, edit)}
          onRetry={(stepId) => actions.retry(run, stepId)}
          onInspectStep={inspectStep}
          onCite={cite}
        />
      )}
      {status === 'Clarifying' && pending?.kind === 'clarify' && (
        <ClarificationCard
          pending={pending}
          composerHasText={actions.composerHasText}
          busy={busy}
          onPick={(optionId) => actions.clarify(run, optionId)}
          onCancel={() => actions.cancel(run)}
        />
      )}
      {status === 'AwaitingConsent' && pending?.kind === 'consent' && (
        <ConsentCard
          pending={pending}
          composerHasText={actions.composerHasText}
          busy={busy}
          onAccept={() => actions.consent(run, true)}
          onDecline={() => actions.consent(run, false)}
        />
      )}
      {status === 'AwaitingConfirmation' && pending?.kind === 'confirm' && view && (
        <ConfirmationCard
          // A new nonce (an edit's new version) is a new card: fresh focus, no ticked boxes.
          key={pending.nonce}
          pending={pending}
          facts={view.facts}
          composerHasText={actions.composerHasText}
          progress={actions.saveState(pending.nonce).progress}
          busy={busy || actions.saveState(pending.nonce).saving}
          error={actions.saveState(pending.nonce).error}
          canRename={isLatest}
          onCreate={(makeActive) => actions.create(run, pending, makeActive)}
          onDontSave={() => actions.dontSave(run, pending)}
          onRename={(ref, name) => actions.edit(run, { field: 'cohortName', ref, value: name })}
          onCite={cite}
        />
      )}
      {view?.vizSpecs.map((spec) => (
        // Esc inside a viewer belongs to ProteinPaint's menus, never to Stop.
        <div key={spec.vizId} data-orion-viz>
          <VizCard
            threadId={view.threadId}
            run={view}
            spec={spec}
            onReport={actions.reportViz}
            onOpenInTool={(appId, cohortId) => actions.openInTool(run, spec, appId, cohortId)}
            loadUntrimmedSpec={actions.loadUntrimmedSpec}
          />
        </div>
      ))}
      {showAnswer && view && (
        <AnswerCard
          status={status}
          view={limited ? { ...view, limitations: [] } : view}
          onCite={cite}
          onAsk={actions.askFollowUp}
          onOpenLink={actions.openLink}
        />
      )}
      {limited && view && (
        <LimitationCard
          variant={status === 'Unsupported' ? 'unsupported' : 'limited'}
          limitations={view.limitations}
          facts={view.facts}
          notice={view.notice}
          onCite={cite}
          onOpenOnCohort={(appId) => actions.openOnCohort(run, appId, ['base'])}
          handoffDisabledReason={handoff?.disabledReason ?? null}
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
          server; this card follows it.
        </p>
      )}
    </article>
  );
};
