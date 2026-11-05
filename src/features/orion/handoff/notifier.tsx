import React from 'react';
import { Button } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { newId } from '../ids';

/**
 * How the Assistant tells the researcher about a write it just made (with Undo) or a hand-off it
 * could not make. The default uses the platform's own notifications, which Gen3Provider mounts and
 * which outlive a same-tab hand-off.
 */
export interface Notifier {
  /** `onUndo` returns false when the change can no longer be undone. */
  undo(message: string, onUndo: () => boolean): void;
  error(message: string): void;
}

const UNDO_MS = 10_000;

const UndoMessage = ({ text, onUndo }: { text: string; onUndo: () => void }) => (
  <span className="flex flex-wrap items-center gap-2">
    <span>{text}</span>
    <Button type="button" size="compact-xs" variant="outline" onClick={onUndo}>
      Undo
    </Button>
  </span>
);

export const mantineNotifier: Notifier = {
  undo(message, onUndo) {
    const id = `orion-undo-${newId()}`;
    notifications.show({
      id,
      message: (
        <UndoMessage
          text={message}
          onUndo={() => {
            const undone = onUndo();
            notifications.update({
              id,
              message: undone ? 'Undone: the previous cohort is active again.' : 'This change can no longer be undone.',
              autoClose: 4000,
            });
          }}
        />
      ),
      autoClose: UNDO_MS,
      withCloseButton: true,
    });
  },
  error(message) {
    notifications.show({ message, color: 'red', autoClose: UNDO_MS, withCloseButton: true });
  },
};
