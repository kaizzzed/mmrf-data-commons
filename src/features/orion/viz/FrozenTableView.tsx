import React, { type ReactNode } from 'react';
import type { Fact, FrozenTable } from '../agui/types';
import { factMap, Segments } from '../cards/FactChip';

export interface FrozenTableViewProps {
  frozen: FrozenTable | null;
  facts: readonly Fact[];
  /** The table's accessible name, such as the card title. */
  label: string;
  /** Shown when the spec has no frozen table. */
  empty?: ReactNode;
  /** Opens a cell's fact in the Evidence Inspector, as every chip in the thread does. */
  onCite?: (factId: string) => void;
}

/**
 * The cited output a card shows when its viewer is not live (contract "Viz specs", `frozen`): a
 * tool-returned number keeps its chip (FR-16), naming its row and step, as everywhere in the thread.
 */
export const FrozenTableView = ({ frozen, facts, label, empty, onCite }: FrozenTableViewProps) => {
  if (!frozen) {
    return <p className="text-sm">{empty ?? 'This chart has no cited table to show.'}</p>;
  }
  const byId = factMap(facts);
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
                    <Segments segments={[cell]} facts={byId} onCite={onCite} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {frozen.note && (
        <p className="text-xs" data-testid="orion-viz-frozen-note">
          <Segments segments={frozen.note} facts={byId} onCite={onCite} />
        </p>
      )}
    </div>
  );
};
