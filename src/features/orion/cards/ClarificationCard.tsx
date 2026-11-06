import React, { useId, useRef } from 'react';
import { Button } from '@mantine/core';
import type { ClarifyPending } from '../agui/types';
import { RunStatusLabel } from '../components/StatusLabel';
import { Card } from './Card';
import { useAppearFocus } from './useAppearFocus';

export interface ClarificationCardProps {
  pending: ClarifyPending;
  /** Read once, when the card appears: typed text keeps focus in the composer. */
  composerHasText?: boolean | (() => boolean);
  /** A turn for this run is in flight: the options wait. */
  busy?: boolean;
  onPick: (optionId: string) => void;
  onCancel: () => void;
}

/** At most one question per run (FR-04, E10); each option names a field and previews its values. */
export const ClarificationCard = ({
  pending,
  composerHasText = false,
  busy = false,
  onPick,
  onCancel,
}: ClarificationCardProps) => {
  const titleId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  useAppearFocus(headingRef, composerHasText);
  return (
    <Card
      titleId={titleId}
      titleRef={headingRef}
      title={pending.question}
      status={<RunStatusLabel status="Clarifying" className="text-sm font-medium" />}
    >
      <ul aria-label="Options" className="flex flex-wrap gap-2">
        {pending.options.map((option) => (
          <li key={option.optionId}>
            <Button
              type="button"
              variant="default"
              radius="xl"
              size="sm"
              disabled={busy}
              onClick={() => onPick(option.optionId)}
              className="h-auto py-1"
              aria-label={`${option.label}: ${option.preview}`}
            >
              <span className="flex flex-col items-start text-left">
                <span>{option.label}</span>
                <span className="text-xs font-normal">{option.preview}</span>
              </span>
            </Button>
          </li>
        ))}
      </ul>
      <div>
        <Button type="button" variant="subtle" size="xs" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </Card>
  );
};
