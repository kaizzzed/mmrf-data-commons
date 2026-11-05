import React, { useId } from 'react';
import type { OrionCode } from '../agui/types';
import { RunStatusLabel } from '../components/StatusLabel';
import { Card } from './Card';

export interface FailedCardProps {
  code: OrionCode | null;
  message: string | null;
}

/** A "Could not plan" card when both models declined, else the failed check by code. */
export const FailedCard = ({ code, message }: FailedCardProps) => {
  const titleId = useId();
  return (
    <Card
      titleId={titleId}
      title={code === 'PLANNER_DECLINED' ? 'Could not plan' : 'This run failed'}
      status={<RunStatusLabel status="Failed" className="text-sm font-medium" />}
    >
      {message && <p className="text-sm">{message}</p>}
      {code && <p className="font-mono text-xs">{code}</p>}
    </Card>
  );
};
