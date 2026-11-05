import React, { useId } from 'react';
import { Button } from '@mantine/core';
import type { AppId, Fact, Limitation, NearestApp } from '../agui/types';
import { RunStatusLabel } from '../components/StatusLabel';
import { SYNTHETIC_NOTICE } from '../constants';
import { LimitationLine } from './AnswerCard';
import { Card } from './Card';
import { factMap } from './FactChip';

export interface LimitationCardProps {
  variant?: 'limited' | 'unsupported';
  limitations: Limitation[];
  facts?: readonly Fact[];
  /** The deployment's notice, which ends every limitation card. */
  notice?: string;
  onCite?: (factId: string) => void;
  /** Click-only hand-off: the nearest app opens in this tab on the run's cohort. Absent: none offered. */
  onOpenOnCohort?: (appId: AppId) => void;
  /** Why the hand-off is off, such as Don't save (WRITE_SKIPPED); the button stays, disabled, with it. */
  handoffDisabledReason?: string | null;
}

const NearestAppLine = ({
  nearestApp,
  onOpenOnCohort,
  disabledReason,
}: {
  nearestApp: NearestApp;
  onOpenOnCohort: (appId: AppId) => void;
  disabledReason: string | null;
}) => {
  const reasonId = useId();
  return (
    <div className="flex flex-wrap items-center gap-3 text-sm">
      <span>
        <span className="font-medium">Nearest app:</span> {nearestApp.title}
      </span>
      <Button
        type="button"
        variant="outline"
        size="xs"
        disabled={disabledReason !== null}
        aria-describedby={disabledReason ? reasonId : undefined}
        onClick={() => onOpenOnCohort(nearestApp.appId)}
      >
        Open on this cohort
      </Button>
      {disabledReason && (
        <span id={reasonId} className="text-xs">
          {disabledReason}
        </span>
      )}
    </div>
  );
};

const NO_FACTS: readonly Fact[] = [];

/** What is missing, why it blocks the answer, and what would unblock it (FR-17, C-06). */
export const LimitationCard = ({
  variant = 'limited',
  limitations,
  facts = NO_FACTS,
  notice = SYNTHETIC_NOTICE,
  onCite,
  onOpenOnCohort,
  handoffDisabledReason = null,
}: LimitationCardProps) => {
  const titleId = useId();
  const unsupported = variant === 'unsupported';
  const lookup = factMap(facts);
  // With no app listed, the card says nothing about which apps exist.
  const nearestApp: NearestApp | undefined = limitations.flatMap((l) => l.nearestApps)[0];
  return (
    <Card
      titleId={titleId}
      title={unsupported ? 'This question is not supported' : 'A limitation stopped this run'}
      status={<RunStatusLabel status={unsupported ? 'Unsupported' : 'Limited'} className="text-sm font-medium" />}
    >
      {limitations.length > 0 && (
        <ul className="flex flex-col gap-2 text-sm">
          {limitations.map((limitation, i) => (
            <li key={`${limitation.code}-${i}`}>
              <LimitationLine limitation={limitation} facts={lookup} onCite={onCite} />
            </li>
          ))}
        </ul>
      )}
      {nearestApp && onOpenOnCohort && (
        <NearestAppLine
          nearestApp={nearestApp}
          onOpenOnCohort={onOpenOnCohort}
          disabledReason={handoffDisabledReason}
        />
      )}
      <p className="text-xs">{notice}</p>
    </Card>
  );
};
