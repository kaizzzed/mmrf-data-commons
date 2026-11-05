import React, { useId } from 'react';
import { Button } from '@mantine/core';
import { RunStatusLabel } from '../components/StatusLabel';
import { Card } from './Card';

export interface ClarificationOption {
  id: string;
  /** A vocabulary field, such as "CGS risk category". */
  label: string;
  /** Its values, such as "High risk, Standard risk". */
  preview: string;
}

export interface ClarificationCardProps {
  question: string;
  options: ClarificationOption[];
  onPick?: (optionId: string) => void;
  onCancel?: () => void;
}

/** One question; each option names a field and previews its values. */
export const ClarificationCard = ({
  question,
  options,
  onPick,
  onCancel,
}: ClarificationCardProps) => {
  const titleId = useId();
  return (
    <Card
      titleId={titleId}
      title={question}
      status={<RunStatusLabel status="Clarifying" className="text-sm font-medium" />}
    >
      <ul aria-label="Options" className="flex flex-wrap gap-2">
        {options.map((option) => (
          <li key={option.id}>
            <Button
              type="button"
              variant="default"
              radius="xl"
              size="sm"
              disabled={!onPick}
              onClick={() => onPick?.(option.id)}
              className="h-auto py-1"
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
        <Button type="button" variant="subtle" size="xs" disabled={!onCancel} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </Card>
  );
};
