import React, { type ReactNode } from 'react';
import type { Fact, FrozenTable, Segment } from '../agui/types';
import { citationLabel } from '../format';

const CHIP_CLASS =
  'ml-1 inline-flex items-center rounded-full border border-base-light px-2 py-px align-baseline font-mono text-xs';

/** A cell or note segment: a tool-returned number keeps its chip (FR-16), naming its row and step. */
const SegmentText = ({ segment, facts }: { segment: Segment; facts: ReadonlyMap<string, Fact> }) => {
  if (!segment.factId) return <span>{segment.text}</span>;
  const fact = facts.get(segment.factId);
  return (
    <span data-fact-id={segment.factId}>
      <span className="font-semibold">{segment.text}</span>
      <span className={CHIP_CLASS}>{fact ? citationLabel(fact) : `Unresolved · ${segment.factId}`}</span>
    </span>
  );
};

const Segments = ({ segments, facts }: { segments: readonly Segment[]; facts: ReadonlyMap<string, Fact> }) => (
  <>
    {segments.map((segment, i) => (
      <SegmentText key={i} segment={segment} facts={facts} />
    ))}
  </>
);

export interface FrozenTableViewProps {
  frozen: FrozenTable | null;
  facts: readonly Fact[];
  /** The table's accessible name, such as the card title. */
  label: string;
  /** Shown when the spec has no frozen table. */
  empty?: ReactNode;
}

/** The cited output a card shows when its viewer is not live (contract "Viz specs", `frozen`). */
export const FrozenTableView = ({ frozen, facts, label, empty }: FrozenTableViewProps) => {
  if (!frozen) {
    return <p className="text-sm">{empty ?? 'This chart has no cited table to show.'}</p>;
  }
  const byId = new Map(facts.map((f) => [f.id, f]));
  return (
    <div className="flex flex-col gap-1" data-testid="orion-viz-frozen">
      <div className="overflow-x-auto">
        <table className="min-w-full border-collapse text-sm" aria-label={`Cited output: ${label}`}>
          <thead>
            <tr>
              {frozen.columns.map((column) => (
                <th key={column} scope="col" className="border-b border-base-light px-2 py-1 text-left font-semibold">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {frozen.rows.map((row, r) => (
              <tr key={r}>
                {row.map((cell, c) => (
                  <td key={c} className="border-b border-base-lightest px-2 py-1">
                    <SegmentText segment={cell} facts={byId} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {frozen.note && (
        <p className="text-xs" data-testid="orion-viz-frozen-note">
          <Segments segments={frozen.note} facts={byId} />
        </p>
      )}
    </div>
  );
};
