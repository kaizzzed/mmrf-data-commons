import React, { forwardRef, useId } from 'react';
import { Button, Textarea } from '@mantine/core';
import { LuSend, LuSquare } from 'react-icons/lu';
import { composerKeyAction } from './composerKeys';

export interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  /** A run on this thread is streaming: Send becomes Stop. */
  running: boolean;
  scopeLabel: string;
}

export const Composer = forwardRef<HTMLTextAreaElement, ComposerProps>(function Composer(
  { value, onChange, onSend, onStop, running, scopeLabel },
  ref,
) {
  const scopeId = useId();
  const hasText = value.trim().length > 0;

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const action = composerKeyAction(
      {
        key: event.key,
        shiftKey: event.shiftKey,
        isComposing: event.nativeEvent.isComposing,
      },
      { running, hasText },
    );
    if (action === 'send' || action === 'stop' || action === 'hold') event.preventDefault();
    if (action === 'send') onSend();
    if (action === 'stop') onStop();
  };

  return (
    <div className="flex flex-col gap-2">
      <Textarea
        ref={ref}
        label="Ask ORION"
        placeholder="Ask about the cohort in scope. Enter sends; Shift+Enter adds a line."
        autosize
        minRows={2}
        maxRows={8}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        onKeyDown={onKeyDown}
        aria-describedby={scopeId}
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        {/* Switching scope from the chip lands on Day 1 PM. */}
        <span
          id={scopeId}
          className="rounded-full border border-base-light px-3 py-1 text-xs"
        >
          {scopeLabel}
        </span>
        {running ? (
          <Button
            type="button"
            variant="outline"
            leftSection={<LuSquare aria-hidden focusable="false" />}
            onClick={onStop}
          >
            Stop
          </Button>
        ) : (
          <Button
            type="button"
            leftSection={<LuSend aria-hidden focusable="false" />}
            disabled={!hasText}
            onClick={onSend}
          >
            Send
          </Button>
        )}
      </div>
    </div>
  );
});
