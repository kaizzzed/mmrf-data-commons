import React, { useId } from 'react';
import { LuPenLine } from 'react-icons/lu';
import type { Fact, RunStatus, RunView, Sentence } from '../agui/types';
import { SYNTHETIC_NOTICE } from '../constants';
import { citationLabel } from '../format';
import { Card } from './Card';

const CHIP_CLASS =
  'ml-1 inline-flex items-center rounded-full border border-base-light px-2 py-px align-baseline font-mono text-xs';

const CitationChip = ({
  fact,
  factId,
  onCite,
}: {
  fact: Fact | undefined;
  factId: string;
  onCite?: (factId: string) => void;
}) => {
  const label = fact ? citationLabel(fact) : `Unresolved · ${factId}`;
  return onCite ? (
    <button type="button" className={`${CHIP_CLASS} hover:bg-base-lightest`} onClick={() => onCite(factId)}>
      {label}
    </button>
  ) : (
    <span className={CHIP_CLASS}>{label}</span>
  );
};

const SentenceText = ({
  sentence,
  facts,
  onCite,
}: {
  sentence: Sentence;
  facts: ReadonlyMap<string, Fact>;
  onCite?: (factId: string) => void;
}) => (
  <p className="text-sm leading-relaxed">
    {sentence.segments.map((segment, i) =>
      segment.factId ? (
        <span key={i}>
          <span className="font-semibold">{segment.text}</span>
          <CitationChip fact={facts.get(segment.factId)} factId={segment.factId} onCite={onCite} />
        </span>
      ) : (
        <span key={i}>{segment.text}</span>
      ),
    )}
  </p>
);

const DEFAULT_WITHHELD_REASON: Partial<Record<RunStatus, string>> = {
  Partial: 'a step failed',
  Cancelled: 'the run was stopped',
  Interrupted: 'the run was interrupted',
  ObservedOnly: 'the model text did not pass verification',
};

export const withheldLine = (view: Pick<RunView, 'withheldReason'>, status: RunStatus): string =>
  `Interpretation withheld: ${
    view.withheldReason ?? DEFAULT_WITHHELD_REASON[status] ?? 'no interpretation is available'
  }`;

export interface AnswerCardProps {
  status: RunStatus;
  view: RunView;
  onCite?: (factId: string) => void;
}

/** Observed, then Interpretation and Hypotheses or the withheld line, then Limitations. */
export const AnswerCard = ({ status, view, onCite }: AnswerCardProps) => {
  const titleId = useId();
  const facts = new Map(view.facts.map((f) => [f.id, f]));
  const interpreted = !!view.interpretation && view.interpretation.length > 0;
  const sentences = (items: Sentence[]) =>
    items.map((sentence, i) => (
      <SentenceText key={i} sentence={sentence} facts={facts} onCite={onCite} />
    ));

  return (
    <Card titleId={titleId} title="Answer">
      <div>
        <h4 className="text-sm font-semibold">Observed</h4>
        {view.observed.length > 0 ? (
          sentences(view.observed)
        ) : (
          <p className="text-sm">No tool output to report.</p>
        )}
      </div>
      {interpreted ? (
        <>
          <div>
            <h4 className="text-sm font-semibold">Interpretation</h4>
            {sentences(view.interpretation ?? [])}
          </div>
          {view.hypotheses && view.hypotheses.length > 0 && (
            <div>
              <h4 className="text-sm font-semibold">Hypotheses and next steps</h4>
              {sentences(view.hypotheses)}
            </div>
          )}
        </>
      ) : status === 'Answering' ? (
        <p className="inline-flex items-center gap-1 text-sm">
          <LuPenLine aria-hidden focusable="false" />
          Writing interpretation
        </p>
      ) : (
        <p className="text-sm">{withheldLine(view, status)}</p>
      )}
      {view.limitations.length > 0 && (
        <div>
          <h4 className="text-sm font-semibold">Limitations</h4>
          <ul className="list-disc pl-5 text-sm">
            {view.limitations.map((l, i) => (
              <li key={`${l.code}-${i}`}>{l.text}</li>
            ))}
          </ul>
        </div>
      )}
      <p className="text-xs">{SYNTHETIC_NOTICE}</p>
    </Card>
  );
};
