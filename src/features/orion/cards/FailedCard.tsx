import React, { useId } from 'react';
import type { OrionCode } from '../agui/types';
import { RunStatusLabel } from '../components/StatusLabel';
import { Card } from './Card';

export interface FailedCardProps {
  code: OrionCode | null;
  message: string | null;
}

const TITLES: Partial<Record<OrionCode, string>> = {
  PLANNER_DECLINED: 'Could not plan',
  WRITE_VERIFY_FAILED: 'The saved cohorts did not read back as planned',
};

const NEXT: Partial<Record<OrionCode, string>> = {
  PLANNER_DECLINED: 'Rephrase the question, or ask again.',
  WRITE_VERIFY_FAILED:
    'Check the cohort list: the cohorts the click created stay saved. Ask again to repeat the analysis.',
};

/** A "Could not plan" card (PLANNER_DECLINED), or the failed check by its code (C-19). */
export const FailedCard = ({ code, message }: FailedCardProps) => {
  const titleId = useId();
  return (
    <Card
      titleId={titleId}
      title={(code && TITLES[code]) ?? 'This run failed'}
      status={<RunStatusLabel status="Failed" className="text-sm font-medium" />}
    >
      {message && <p className="text-sm">{message}</p>}
      <p className="text-sm">{(code && NEXT[code]) ?? 'Ask again, or rephrase the question.'}</p>
      {code && <p className="font-mono text-xs">{code}</p>}
    </Card>
  );
};
