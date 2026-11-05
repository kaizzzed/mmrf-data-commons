import React, { useId, useRef, useState } from 'react';
import { Button, Checkbox, TextInput } from '@mantine/core';
import type { ConfirmPending, Fact, PendingCohort } from '../agui/types';
import { RunStatusLabel } from '../components/StatusLabel';
import type { SaveProgress } from '../cohort/saveLedger';
import { plural } from '../format';
import { Card } from './Card';
import { factMap, FactNumber, type FactLookup } from './FactChip';
import { useAppearFocus } from './useAppearFocus';

export interface ConfirmationCardProps {
  pending: ConfirmPending;
  facts: readonly Fact[];
  /** Read once, when the card appears: typed text keeps focus in the composer. */
  composerHasText: boolean | (() => boolean);
  /** How far an earlier Create of this nonce got ("1 of 2 saved"), from the save ledger. */
  progress?: SaveProgress | null;
  /** A turn for this run is in flight, or Create is saving: every button waits. */
  busy?: boolean;
  /** Why the last Create did not finish. */
  error?: string | null;
  /** False once the plan cannot take a rename (not the thread's latest run). */
  canRename?: boolean;
  onCreate: (makeActiveRef: string | null) => void;
  onDontSave: () => void;
  onRename: (ref: string, name: string) => void;
  onCite?: (factId: string) => void;
}

const MAX_NAME = 100;

const RenameField = ({
  cohort,
  disabled,
  onRename,
  onDone,
}: {
  cohort: PendingCohort;
  disabled: boolean;
  onRename: (ref: string, name: string) => void;
  onDone: () => void;
}) => {
  const [name, setName] = useState(cohort.name);
  const trimmed = name.trim();
  const valid = trimmed.length > 0 && trimmed.length <= MAX_NAME && trimmed !== cohort.name;
  return (
    <div className="flex flex-wrap items-end gap-2">
      <TextInput
        label={`New name for ${cohort.name}`}
        value={name}
        maxLength={MAX_NAME}
        onChange={(event) => setName(event.currentTarget.value)}
        // No form: Enter in the field does nothing, so only the button renames. The field opens
        // on the researcher's own click, so it takes focus.
        className="min-w-[16rem]"
        autoFocus
      />
      <Button
        type="button"
        variant="default"
        size="xs"
        disabled={!valid || disabled}
        onClick={() => {
          onRename(cohort.ref, trimmed);
          onDone();
        }}
      >
        Use this name
      </Button>
      <Button type="button" variant="subtle" size="xs" onClick={onDone}>
        Keep the name
      </Button>
    </div>
  );
};

const CohortItem = ({
  cohort,
  facts,
  makeActive,
  setMakeActive,
  renaming,
  setRenaming,
  canRename,
  busy,
  onRename,
  onCite,
}: {
  cohort: PendingCohort;
  facts: FactLookup;
  makeActive: boolean;
  setMakeActive: (on: boolean) => void;
  renaming: boolean;
  setRenaming: (on: boolean) => void;
  canRename: boolean;
  busy: boolean;
  onRename: (ref: string, name: string) => void;
  onCite?: (factId: string) => void;
}) => (
  <li className="flex flex-col gap-1">
    <h4 className="text-sm font-semibold">{cohort.name}</h4>
    <span>{cohort.definitionText}</span>
    <span>
      <FactNumber value={cohort.caseCount} factId={cohort.caseCountFactId} facts={facts} onCite={onCite} />{' '}
      {cohort.caseCount === 1 ? 'case' : 'cases'}
      {cohort.eligibleCount !== null && (
        <>
          {' · '}
          <FactNumber
            value={cohort.eligibleCount}
            factId={cohort.eligibleCountFactId}
            facts={facts}
            onCite={onCite}
          />{' '}
          RNA-seq eligible
        </>
      )}
    </span>
    {cohort.reuse && <span>Already saved as {cohort.reuse.name}</span>}
    <Checkbox
      label={`Make ${cohort.name} the active cohort after saving`}
      checked={makeActive}
      disabled={busy}
      onChange={(event) => setMakeActive(event.currentTarget.checked)}
    />
    {renaming ? (
      <RenameField cohort={cohort} disabled={busy || !canRename} onRename={onRename} onDone={() => setRenaming(false)} />
    ) : (
      <div>
        <Button
          type="button"
          variant="subtle"
          size="compact-sm"
          disabled={busy || !canRename}
          onClick={() => setRenaming(true)}
          aria-label={`Rename ${cohort.name}`}
        >
          Rename
        </Button>
      </div>
    )}
  </li>
);

/**
 * The only door to a write. Focus lands on the heading, never on Create, and no button is a
 * default: Enter pressed elsewhere can never save. Create is bound to this card's nonce and plan
 * signature by its caller; a new nonce remounts the card.
 */
export const ConfirmationCard = ({
  pending,
  facts,
  composerHasText,
  progress = null,
  busy = false,
  error = null,
  canRename = true,
  onCreate,
  onDontSave,
  onRename,
  onCite,
}: ConfirmationCardProps) => {
  const titleId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [makeActiveRef, setMakeActiveRef] = useState<string | null>(null);
  const [renamingRef, setRenamingRef] = useState<string | null>(null);
  const lookup = factMap(facts);
  const total = pending.cohorts.length;
  const resumed = !!progress && progress.saved > 0;
  useAppearFocus(headingRef, composerHasText);

  return (
    <Card
      titleId={titleId}
      titleRef={headingRef}
      title={`Save ${plural(total, 'cohort')}`}
      status={<RunStatusLabel status="AwaitingConfirmation" className="text-sm font-medium" />}
    >
      <p className="text-sm">
        Nothing is saved until you choose Create. Don&apos;t save continues with unsaved groups.
      </p>
      <ul className="flex flex-col gap-3 text-sm">
        {pending.cohorts.map((cohort) => (
          <CohortItem
            key={cohort.ref}
            cohort={cohort}
            facts={lookup}
            makeActive={makeActiveRef === cohort.ref}
            setMakeActive={(on) => setMakeActiveRef(on ? cohort.ref : null)}
            renaming={renamingRef === cohort.ref}
            setRenaming={(on) => setRenamingRef(on ? cohort.ref : null)}
            canRename={canRename}
            busy={busy}
            onRename={onRename}
            onCite={onCite}
          />
        ))}
      </ul>
      {resumed && progress && (
        <p role="status" className="text-sm font-medium">
          {progress.saved} of {progress.total} saved. Finish saving creates only the rest.
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm font-medium text-utility-error">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="default" disabled={busy} onClick={() => onCreate(makeActiveRef)}>
          {resumed ? 'Finish saving' : 'Create'}
        </Button>
        <Button type="button" variant="default" disabled={busy} onClick={onDontSave}>
          Don&apos;t save
        </Button>
      </div>
    </Card>
  );
};
