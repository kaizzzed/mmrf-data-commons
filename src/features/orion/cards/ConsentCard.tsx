import React, { useId, useRef } from 'react';
import { Button } from '@mantine/core';
import type { ConsentPending } from '../agui/types';
import { RunStatusLabel } from '../components/StatusLabel';
import { Card } from './Card';
import { useAppearFocus } from './useAppearFocus';

export interface ConsentCardProps {
  pending: ConsentPending;
  composerHasText?: boolean | (() => boolean);
  busy?: boolean;
  onAccept: () => void;
  /** Declining the substitution ends the run "Stopped by you" (FR-23). */
  onDecline: () => void;
}

/** A named tool that cannot do the job: the reason, a proposed tool, and the researcher's choice (FR-02, E7). */
export const ConsentCard = ({ pending, composerHasText = false, busy = false, onAccept, onDecline }: ConsentCardProps) => {
  const titleId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  useAppearFocus(headingRef, composerHasText);
  const { named, proposed, reason } = pending;
  return (
    <Card
      titleId={titleId}
      titleRef={headingRef}
      title={`Use ${proposed.title} instead of ${named.title}?`}
      status={<RunStatusLabel status="AwaitingConsent" className="text-sm font-medium" />}
    >
      <p className="text-sm">{reason}</p>
      <p className="text-sm">Nothing has run yet. The plan above shows what {proposed.title} would do.</p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="default" disabled={busy} onClick={onAccept}>
          Use {proposed.title}
        </Button>
        <Button type="button" variant="default" disabled={busy} onClick={onDecline}>
          Cancel
        </Button>
      </div>
    </Card>
  );
};
