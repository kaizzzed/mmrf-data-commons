import React, { useEffect, useId, useState } from 'react';
import { Button, Code } from '@mantine/core';
import type { Step } from '../agui/types';
import { StepStatusLabel } from '../components/StatusLabel';
import { formatDuration } from '../format';

/** Time since this row first showed the step in flight. */
const useElapsedMs = (active: boolean): number | null => {
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) {
      setStartedAt(null);
      return;
    }
    const start = Date.now();
    setStartedAt(start);
    setNow(start);
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return active && startedAt !== null ? now - startedAt : null;
};

/** What follows the step's word: elapsed time, duration, the reason it was skipped, its code. */
export const stepDetail = (step: Step, elapsedMs: number | null): string | null => {
  switch (step.status) {
    case 'Running':
    case 'Retrying':
      return elapsedMs === null ? null : `${Math.floor(elapsedMs / 1000)} s`;
    case 'Done':
      return step.durationMs === null ? null : formatDuration(step.durationMs);
    case 'Empty':
    case 'Skipped':
      return step.outputSummary;
    case 'Failed':
      return step.code;
    case 'Reused':
      return step.reusedFrom
        ? `from version ${step.reusedFrom.planVersion}${step.reusedFrom.stepId === step.id ? '' : ` · ${step.reusedFrom.stepId}`}`
        : null;
    default:
      return null;
  }
};

export interface StepRowProps {
  step: Step;
  /** Retry step: offered for a failed read on the thread's latest run only. */
  onRetry?: () => void;
  /** A turn for the run is in flight: Retry step waits, as the run's other resume controls do. */
  retryDisabled?: boolean;
  /** Opens the step, its calls and facts in the Evidence Inspector. */
  onInspect?: () => void;
}

/** One counted call: status word and icon, duration, input and output, and its JSON. */
export const StepRow = ({ step, onRetry, retryDisabled = false, onInspect }: StepRowProps) => {
  const [expanded, setExpanded] = useState(false);
  const panelId = useId();
  const inFlight = step.status === 'Running' || step.status === 'Retrying';
  const elapsedMs = useElapsedMs(inFlight);
  const name = `${step.id} ${step.tool}`;

  return (
    <li className={`flex flex-col gap-1 ${step.folded ? 'pl-4 text-xs' : 'text-sm'}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <StepStatusLabel status={step.status} detail={stepDetail(step, elapsedMs)} />
        <span className="font-mono text-xs">{name}</span>
        {step.folded && <span className="text-xs italic">folded step</span>}
        {onRetry && (
          <Button
            type="button"
            variant="outline"
            size="compact-xs"
            disabled={retryDisabled}
            onClick={onRetry}
            aria-label={`Retry step ${name}`}
          >
            Retry step
          </Button>
        )}
        {onInspect && (
          <Button type="button" variant="subtle" size="compact-xs" onClick={onInspect} aria-label={`Inspect ${name}`}>
            Inspect
          </Button>
        )}
        <Button
          type="button"
          variant="subtle"
          size="compact-xs"
          aria-expanded={expanded}
          aria-controls={panelId}
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? 'Hide JSON' : 'Show JSON'}
        </Button>
      </div>
      <p className="text-xs">
        <span className="font-medium">Input:</span> {step.inputSummary}
        {step.outputSummary !== null && (
          <>
            {' · '}
            <span className="font-medium">Output:</span> {step.outputSummary}
          </>
        )}
      </p>
      <div id={panelId} hidden={!expanded}>
        {expanded && (
          <Code block className="max-h-64 overflow-auto text-xs">
            {JSON.stringify(step, null, 2)}
          </Code>
        )}
      </div>
    </li>
  );
};
