import React, { forwardRef, useId } from 'react';
import { Button, Textarea } from '@mantine/core';
import { LuSend, LuSquare } from 'react-icons/lu';
import { MAX_QUESTION_CHARS } from '../constants';
import { formatCount } from '../format';
import { composerKeyAction } from './composerKeys';
import { ScopeChip, type ScopeChipOption } from './ScopeChip';

export interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  /** A run on this thread is active: Send becomes Stop. */
  running: boolean;
  /** The stop is on its way: Stop shows it and waits. */
  stopping?: boolean;
  scopeLabel: string;
  /** Saved cohorts the scope chip can make active. */
  scopeOptions?: readonly ScopeChipOption[];
  onSwitchScope?: (option: ScopeChipOption) => void;
}

export const Composer = forwardRef<HTMLTextAreaElement, ComposerProps>(function Composer(
  { value, onChange, onSend, onStop, running, stopping = false, scopeLabel, scopeOptions = [], onSwitchScope },
  ref,
) {
  const scopeId = useId();
  const length = value.trim().length;
  // A question past the agent's limit is turned away whole, so it does not leave the browser.
  const tooLong = length > MAX_QUESTION_CHARS;
  const hasText = length > 0 && !tooLong;

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
    if (action === 'stop' && !stopping) onStop();
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
        // Mantine sets aria-describedby itself, from its description: the scope the question asks about.
        description={scopeLabel.replace(/^Scope: /, 'Scope for this question: ')}
        classNames={{ description: 'sr-only' }}
        error={
          tooLong
            ? `A question can be at most ${formatCount(MAX_QUESTION_CHARS)} characters; this one has ${formatCount(length)}.`
            : undefined
        }
      />
      <div className="flex flex-wrap items-start justify-between gap-2">
        <ScopeChip label={scopeLabel} labelId={scopeId} options={scopeOptions} onSwitch={onSwitchScope} />
        {running ? (
          <Button
            type="button"
            variant="outline"
            leftSection={<LuSquare aria-hidden focusable="false" />}
            disabled={stopping}
            onClick={onStop}
          >
            {stopping ? 'Stopping' : 'Stop'}
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
