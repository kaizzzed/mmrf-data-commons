import React from 'react';
import type { RunStatus, StepStatus } from '../agui/types';
import { RUN_STATUS_VOCAB, STEP_STATUS_VOCAB, type StatusVocab } from '../status';

interface StatusLabelProps {
  vocab: StatusVocab;
  detail?: string | null;
  className?: string;
}

const StatusLabel = ({ vocab, detail, className = '' }: StatusLabelProps) => {
  const { Icon } = vocab;
  return (
    <span className={`inline-flex items-center gap-1 ${className}`}>
      <Icon
        aria-hidden
        focusable="false"
        className={vocab.spinning ? 'shrink-0 motion-safe:animate-spin' : 'shrink-0'}
      />
      <span>
        {vocab.word}
        {detail ? ` · ${detail}` : ''}
      </span>
    </span>
  );
};

export const RunStatusLabel = ({
  status,
  ...rest
}: { status: RunStatus } & Omit<StatusLabelProps, 'vocab'>) => (
  <StatusLabel vocab={RUN_STATUS_VOCAB[status]} {...rest} />
);

export const StepStatusLabel = ({
  status,
  ...rest
}: { status: StepStatus } & Omit<StatusLabelProps, 'vocab'>) => (
  <StatusLabel vocab={STEP_STATUS_VOCAB[status]} {...rest} />
);
