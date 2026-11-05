import React, { useId } from 'react';
import { Button } from '@mantine/core';
import type { Limitation, NearestApp } from '../agui/types';
import { RunStatusLabel } from '../components/StatusLabel';
import { Card } from './Card';

export type LimitationCardProps = { limitations: Limitation[] } & (
  | { variant?: 'limited' }
  | {
      variant: 'unsupported';
      /** Click-only hand-off: the app opens on the active cohort in this tab. */
      onOpenOnCohort: (appId: string) => void;
    }
);

const NearestAppLine = ({
  nearestApp,
  onOpenOnCohort,
}: {
  nearestApp: NearestApp;
  onOpenOnCohort: (appId: string) => void;
}) => (
  <div className="flex flex-wrap items-center gap-3 text-sm">
    <span>
      <span className="font-medium">Nearest app:</span> {nearestApp.title}
    </span>
    <Button
      type="button"
      variant="outline"
      size="xs"
      onClick={() => onOpenOnCohort(nearestApp.appId)}
    >
      Open on this cohort
    </Button>
  </div>
);

/** What is missing, why it blocks the answer, and what would unblock it. */
export const LimitationCard = (props: LimitationCardProps) => {
  const titleId = useId();
  const unsupported = props.variant === 'unsupported';
  // With no app listed, the card says nothing about which apps exist.
  const nearestApp: NearestApp | undefined = props.limitations.flatMap((l) => l.nearestApps)[0];
  return (
    <Card
      titleId={titleId}
      title={unsupported ? 'This question is not supported' : 'A limitation stopped this run'}
      status={
        <RunStatusLabel
          status={unsupported ? 'Unsupported' : 'Limited'}
          className="text-sm font-medium"
        />
      }
    >
      {props.limitations.length > 0 && (
        <ul className="flex flex-col gap-2 text-sm">
          {props.limitations.map((limitation, i) => (
            <li key={`${limitation.code}-${i}`}>
              <p>{limitation.text}</p>
              {limitation.unblock && (
                <p>
                  <span className="font-medium">What would unblock it:</span>{' '}
                  {limitation.unblock}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
      {props.variant === 'unsupported' && nearestApp && (
        <NearestAppLine nearestApp={nearestApp} onOpenOnCohort={props.onOpenOnCohort} />
      )}
    </Card>
  );
};
