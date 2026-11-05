import React, { useEffect, useId, useRef, useState } from 'react';
import { Button, Checkbox } from '@mantine/core';
import { RunStatusLabel } from '../components/StatusLabel';
import { formatCount } from '../format';
import { RUN_STATUS_VOCAB } from '../status';
import { Card } from './Card';

export interface PendingCohort {
  ref: string;
  name: string;
  definition: string;
  caseCount: number;
  /** RNA-seq eligible cases, when the plan checked eligibility. */
  eligibleCount: number | null;
  /** Name of a saved cohort with the same definition, which is reused. */
  alreadySavedAs: string | null;
}

export interface ConfirmationCardProps {
  cohorts: PendingCohort[];
  /** Read once, when the card appears: typed text keeps focus in the composer. */
  composerHasText: boolean;
  onCreate: (makeActiveRef: string | null) => void;
  onRename: () => void;
  onDontSave: () => void;
  announce?: (message: string) => void;
}

const plural = (n: number, word: string) => `${formatCount(n)} ${word}${n === 1 ? '' : 's'}`;

/**
 * The only door to a write. Focus lands on the heading, never on Create, and no
 * button is a default: Enter pressed elsewhere can never save.
 */
export const ConfirmationCard = ({
  cohorts,
  composerHasText,
  onCreate,
  onRename,
  onDontSave,
  announce,
}: ConfirmationCardProps) => {
  const titleId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [makeActiveRef, setMakeActiveRef] = useState<string | null>(null);
  const title = `Save ${plural(cohorts.length, 'cohort')}`;
  const onAppear = useRef({
    composerHasText,
    announce,
    message: `${RUN_STATUS_VOCAB.AwaitingConfirmation.word}: ${title.toLowerCase()}?`,
  });

  useEffect(() => {
    const { composerHasText: typing, announce: say, message } = onAppear.current;
    if (typing) say?.(message);
    else headingRef.current?.focus();
  }, []);

  return (
    <Card
      titleId={titleId}
      titleRef={headingRef}
      title={title}
      status={<RunStatusLabel status="AwaitingConfirmation" className="text-sm font-medium" />}
    >
      <ul className="flex flex-col gap-3 text-sm">
        {cohorts.map((cohort) => (
          <li key={cohort.ref} className="flex flex-col gap-1">
            <span className="font-medium">{cohort.name}</span>
            <span>{cohort.definition}</span>
            <span>
              {plural(cohort.caseCount, 'case')}
              {cohort.eligibleCount !== null &&
                ` · ${formatCount(cohort.eligibleCount)} RNA-seq eligible`}
            </span>
            {cohort.alreadySavedAs && <span>Already saved as {cohort.alreadySavedAs}</span>}
            <Checkbox
              label="Make active after saving"
              checked={makeActiveRef === cohort.ref}
              onChange={(event) =>
                setMakeActiveRef(event.currentTarget.checked ? cohort.ref : null)
              }
            />
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="default" onClick={() => onCreate(makeActiveRef)}>
          Create
        </Button>
        <Button type="button" variant="default" onClick={onRename}>
          Rename
        </Button>
        <Button type="button" variant="default" onClick={onDontSave}>
          Don&apos;t save
        </Button>
      </div>
    </Card>
  );
};
