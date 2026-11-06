import React from 'react';
import type { Fact, Segment } from '../agui/types';
import { citationLabel, formatCount, formatFact } from '../format';

const CHIP_CLASS =
  'ml-1 inline-flex items-center rounded-full border border-base-light px-2 py-px align-baseline font-mono text-xs';

export interface FactChipProps {
  factId: string;
  fact: Fact | undefined;
  /** Opens the fact's step in the Evidence Inspector; without it the chip is plain text. */
  onCite?: (factId: string) => void;
}

/** A citation chip, "Row n · sN tool": every tool-returned number on screen carries one (FR-16). */
export const FactChip = ({ factId, fact, onCite }: FactChipProps) => {
  const label = fact ? citationLabel(fact) : `Unresolved · ${factId}`;
  return onCite ? (
    <button
      type="button"
      className={`${CHIP_CLASS} hover:bg-base-lightest focus:outline-none focus-visible:ring-2 focus-visible:ring-primary`}
      title={fact ? `${fact.label}: open in the Evidence Inspector` : undefined}
      onClick={() => onCite(factId)}
    >
      {label}
    </button>
  ) : (
    <span className={CHIP_CLASS}>{label}</span>
  );
};

export type FactLookup = ReadonlyMap<string, Fact>;

export const factMap = (facts: readonly Fact[]): FactLookup => new Map(facts.map((f) => [f.id, f]));

/** Segments as text, each one with a `factId` in bold with its chip. */
export const Segments = ({
  segments,
  facts,
  onCite,
}: {
  segments: readonly Segment[];
  facts: FactLookup;
  onCite?: (factId: string) => void;
}) => (
  <>
    {segments.map((segment, i) =>
      segment.factId ? (
        <span key={i}>
          <span className="font-semibold">{segment.text}</span>
          <FactChip factId={segment.factId} fact={facts.get(segment.factId)} onCite={onCite} />
        </span>
      ) : (
        <span key={i}>{segment.text}</span>
      ),
    )}
  </>
);

/**
 * A number the browser writes beside a `…FactId` (the scope line, the confirmation card): the
 * fact's own value through format_fact, with its chip; the plain number when no fact backs it.
 */
export const FactNumber = ({
  value,
  factId,
  facts,
  onCite,
}: {
  value: number;
  factId: string | null;
  facts: FactLookup;
  onCite?: (factId: string) => void;
}) => {
  const fact = factId ? facts.get(factId) : undefined;
  if (!factId || !fact) return <span>{formatCount(value)}</span>;
  return (
    <span>
      <span className="font-semibold">{formatFact(fact.value, fact.unit)}</span>
      <FactChip factId={factId} fact={fact} onCite={onCite} />
    </span>
  );
};
