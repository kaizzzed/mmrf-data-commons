import React, { useId, useState } from 'react';
import { Button, UnstyledButton } from '@mantine/core';
import { formatScope } from '../format';

/** A saved cohort the composer's chip can make active. */
export interface ScopeChipOption {
  cohortId: string;
  name: string;
  caseCount: number | null;
  /** An unfiltered cohort: making it active scopes the next question to all cases. */
  allCases: boolean;
}

export interface ScopeChipProps {
  /** "Scope: <cohort name> · <n> cases". */
  label: string;
  /** The id the composer's text box is described by. */
  labelId: string;
  options: readonly ScopeChipOption[];
  /** Absent: the chip only shows the scope. */
  onSwitch?: (option: ScopeChipOption) => void;
}

/**
 * The composer's scope chip (contract "The composer's scope chip"): picking a cohort runs
 * set_active_cohort in the click, with an undo toast; the next ask carries it in cohortContext.
 */
export const ScopeChip = ({ label, labelId, options, onSwitch }: ScopeChipProps) => {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const chipClass = 'rounded-full border border-base-light px-3 py-1 text-xs';
  if (!onSwitch || options.length === 0) {
    return (
      <span id={labelId} className={chipClass}>
        {label}
      </span>
    );
  }
  return (
    <div
      className="relative flex flex-col gap-1"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <UnstyledButton
        className={`${chipClass} hover:bg-base-lightest focus:outline-none focus-visible:ring-2 focus-visible:ring-primary`}
        aria-expanded={open}
        aria-controls={listId}
        aria-haspopup="true"
        aria-label={`${label}. Switch scope`}
        onClick={() => setOpen((shown) => !shown)}
      >
        <span id={labelId}>{label}</span>
      </UnstyledButton>
      <div id={listId} hidden={!open}>
        {open && (
          <ul aria-label="Make a cohort active" className="flex flex-col gap-1 rounded-md border border-base-lighter p-2">
            {options.map((option) => (
              <li key={option.cohortId}>
                <Button
                  type="button"
                  variant="subtle"
                  size="compact-sm"
                  onClick={() => {
                    setOpen(false);
                    onSwitch(option);
                  }}
                >
                  {formatScope(option.allCases ? `${option.name} (all cases)` : option.name, option.caseCount).replace(
                    /^Scope: /,
                    '',
                  )}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};
