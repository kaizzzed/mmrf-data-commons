import React, { useEffect, useId, useRef } from 'react';
import { Button } from '@mantine/core';

export interface PausePromptProps {
  onCancelAndSend: () => void;
  onKeepWaiting: () => void;
}

/**
 * F2 "Interaction rules": text sent while a run waits asks once. Keep it waiting leaves the text
 * unsent in the composer; a thread never holds two unfinished runs.
 */
export const PausePrompt = ({ onCancelAndSend, onKeepWaiting }: PausePromptProps) => {
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, []);
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2 rounded-md border border-base-light p-3">
      <h3 id={headingId} ref={headingRef} tabIndex={-1} className="text-sm font-semibold focus:outline-none">
        Cancel the waiting run and send this, or keep it waiting?
      </h3>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="default" size="xs" onClick={onCancelAndSend}>
          Cancel the waiting run and send
        </Button>
        <Button type="button" variant="default" size="xs" onClick={onKeepWaiting}>
          Keep it waiting
        </Button>
      </div>
    </section>
  );
};
