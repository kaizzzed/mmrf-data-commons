import React, { useEffect, useId, useRef } from 'react';
import { Button, CloseButton } from '@mantine/core';
import type { RunState } from '../agui/reducer';
import type { RunRoutes } from '../agui/transport';
import type { CallRecord, Fact, JsonValue, RunRecord } from '../agui/types';
import { StepStatusLabel } from '../components/StatusLabel';
import { callOrigin, callsOf } from '../calls';
import { citationLabel, formatDuration, formatFact } from '../format';
import { recordFilename } from '../server/routes';
import { resolvePointer } from './jsonPointer';
import { useRunRecord, type RecordState } from './useRunRecord';

/** What the Inspector shows: a step of a run, and one of its facts when a chip opened it. */
export interface InspectorTarget {
  runId: string;
  stepId: string;
  factId: string | null;
}

/** A JSON block opens on demand and shows at most this much of a large output. */
const JSON_PREVIEW_CHARS = 100_000;

const JsonBlock = ({ label, value }: { label: string; value: JsonValue }) => {
  const text = JSON.stringify(value, null, 2) ?? 'null';
  const clipped = text.length > JSON_PREVIEW_CHARS;
  return (
    <details className="text-xs">
      <summary className="cursor-pointer font-medium">
        {label} ({Math.max(1, Math.round(text.length / 1024))} KB)
      </summary>
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded bg-base-lightest p-2 font-mono">
        {clipped ? `${text.slice(0, JSON_PREVIEW_CHARS)}\n…` : text}
      </pre>
      {clipped && <p>Shortened here; the exported run record has all of it.</p>}
    </details>
  );
};

const CallItem = ({ call }: { call: CallRecord }) => (
  <li className="flex flex-col gap-1 border-t border-base-lighter pt-2 first:border-t-0 first:pt-0">
    <h4 className="break-all font-mono text-xs font-semibold">{call.callId}</h4>
    <p className="text-xs">
      Attempt {call.attempt} · {call.status} · {formatDuration(call.elapsedMs)} · {call.transport}
      {call.httpStatus !== null && ` · HTTP ${call.httpStatus}`}
    </p>
    {call.error && <p className="text-xs">Error: {call.error}</p>}
    {call.warnings.length > 0 && <p className="text-xs">Warnings: {call.warnings.join('; ')}</p>}
    <p className="break-all font-mono text-xs">request sha256 {call.requestSha256}</p>
    {call.responseSha256 && <p className="break-all font-mono text-xs">response sha256 {call.responseSha256}</p>}
    {call.provenance.length > 0 && (
      <ul aria-label={`HTTP requests of ${call.callId}`} className="text-xs">
        {call.provenance.map((p, i) => (
          <li key={i} className="break-all font-mono">
            {p.method} {p.path} → {p.httpStatus ?? 'no response'} · {formatDuration(p.elapsedMs)}
          </li>
        ))}
      </ul>
    )}
    <JsonBlock label="Request" value={call.request} />
    <JsonBlock label="Output" value={call.observed} />
  </li>
);

const FactDetail = ({ fact, record }: { fact: Fact; record: RunRecord | null }) => {
  const stored = record?.facts.find((f) => f.id === fact.id) ?? null;
  const call = stored ? record?.calls.find((c) => c.callId === stored.callId) ?? null : null;
  const atPointer = call ? resolvePointer(call as unknown as JsonValue, fact.jsonPointer) : null;
  return (
    <section aria-label="Fact" className="flex flex-col gap-1">
      <h3 className="text-sm font-semibold">{fact.label || fact.id}</h3>
      <dl className="grid grid-cols-[auto_1fr] gap-x-2 text-xs">
        <dt className="font-medium">Value</dt>
        <dd>
          {formatFact(fact.value, fact.unit)} {fact.unit}
        </dd>
        <dt className="font-medium">Fact</dt>
        <dd className="break-all font-mono">{fact.id}</dd>
        <dt className="font-medium">Pointer</dt>
        <dd className="break-all font-mono">{fact.jsonPointer}</dd>
        {stored && (
          <>
            <dt className="font-medium">Call</dt>
            <dd className="break-all font-mono">{stored.callId}</dd>
            <dt className="font-medium">Engine</dt>
            <dd>{stored.engine ?? 'ORION (computed in code)'}</dd>
          </>
        )}
        {atPointer && (
          <>
            <dt className="font-medium">In the call</dt>
            <dd className="break-all font-mono">
              {atPointer.found ? JSON.stringify(atPointer.value) : 'not found at this pointer'}
            </dd>
          </>
        )}
      </dl>
    </section>
  );
};

const UNAVAILABLE_TEXT: Record<Extract<RecordState, { state: 'unavailable' }>['reason'], string> = {
  'no-route': 'The run record is not available in a fixture replay.',
  'not-stored': 'The run record is not available yet.',
  'signed-out': 'The run record cannot be read: your session has ended. Sign in again to see it.',
};

export interface EvidenceInspectorProps {
  threadId: string;
  target: InspectorTarget;
  run: RunState | undefined;
  routes: RunRoutes | null;
  onSelect: (target: InspectorTarget) => void;
  onClose: () => void;
}

/**
 * The right-hand panel a chip or a step opens (F1 "Evidence Inspector"): the step's request and
 * output, its facts, and the run record, which exports as JSON. Chips and the Inspector name both
 * the plan row and the step, "Row n · sN tool" (C-15).
 */
export const EvidenceInspector = ({ threadId, target, run, routes, onSelect, onClose }: EvidenceInspectorProps) => {
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const view = run?.view ?? null;
  const step = view?.steps.find((s) => s.id === target.stepId);
  const fact = target.factId ? view?.facts.find((f) => f.id === target.factId) : undefined;
  const stepFacts = view?.facts.filter((f) => f.stepId === target.stepId) ?? [];
  const recordState = useRunRecord(routes, target.runId, threadId, view?.revision ?? null);
  const record = recordState.state === 'ready' ? recordState.record : null;
  const calls = record && view && step ? callsOf(record.calls, callOrigin(view, step.id)) : [];

  useEffect(() => {
    headingRef.current?.focus();
  }, [target.runId, target.stepId, target.factId]);

  return (
    <aside
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-md border border-base-lighter p-3 md:w-96 md:shrink-0"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        onClose();
      }}
    >
      <header className="flex items-center justify-between gap-2">
        <h2
          id={headingId}
          ref={headingRef}
          tabIndex={-1}
          className="font-heading text-[1rem] font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          Evidence Inspector
        </h2>
        <CloseButton aria-label="Close the Evidence Inspector" onClick={onClose} />
      </header>
      {!step ? (
        <p className="text-sm">This step is not in the run&apos;s current plan.</p>
      ) : (
        <>
          <section aria-label="Step" className="flex flex-col gap-1">
            <h3 className="font-mono text-sm font-semibold">{citationLabel({ row: step.row, stepId: step.id, tool: step.tool })}</h3>
            <StepStatusLabel status={step.status} detail={step.code} className="text-sm" />
            <p className="text-xs">
              <span className="font-medium">Input:</span> {step.inputSummary}
            </p>
            {step.outputSummary !== null && (
              <p className="text-xs">
                <span className="font-medium">Output:</span> {step.outputSummary}
              </p>
            )}
            {step.durationMs !== null && <p className="text-xs">Took {formatDuration(step.durationMs)}</p>}
            {step.reusedFrom && (
              <p className="text-xs">
                Reused from version {step.reusedFrom.planVersion}, step {step.reusedFrom.stepId}: its calls are shown.
              </p>
            )}
          </section>
          {fact && <FactDetail fact={fact} record={record} />}
          {stepFacts.length > 0 && (
            <section aria-label="Facts from this step" className="flex flex-col gap-1">
              <h3 className="text-sm font-semibold">Facts from this step</h3>
              <ul className="flex flex-col gap-1 text-xs">
                {stepFacts.map((f) => (
                  <li key={f.id}>
                    <Button
                      type="button"
                      variant="subtle"
                      size="compact-xs"
                      aria-current={f.id === target.factId ? 'true' : undefined}
                      onClick={() => onSelect({ runId: target.runId, stepId: target.stepId, factId: f.id })}
                    >
                      {f.label || f.id}: {formatFact(f.value, f.unit)}
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section aria-label="Calls" className="flex flex-col gap-1">
            <h3 className="text-sm font-semibold">Calls</h3>
            {recordState.state === 'loading' && <p className="text-xs">Reading the run record…</p>}
            {recordState.state === 'unavailable' && <p className="text-xs">{UNAVAILABLE_TEXT[recordState.reason]}</p>}
            {recordState.state === 'error' && <p className="text-xs">The run record could not be read: {recordState.message}</p>}
            {record && calls.length === 0 && <p className="text-xs">The record has no call for this step yet.</p>}
            {calls.length > 0 && (
              <ol className="flex flex-col gap-2">
                {calls.map((call) => (
                  <CallItem key={call.callId} call={call} />
                ))}
              </ol>
            )}
          </section>
        </>
      )}
      {routes && (
        <a
          className="text-sm underline"
          href={routes.recordDownloadHref(target.runId, threadId)}
          download={recordFilename(target.runId)}
        >
          Export the run record as JSON
        </a>
      )}
    </aside>
  );
};
