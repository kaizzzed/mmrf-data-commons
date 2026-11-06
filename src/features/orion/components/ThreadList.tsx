import React from 'react';
import { Button, UnstyledButton } from '@mantine/core';
import { LuPlus } from 'react-icons/lu';
import type { ThreadState } from '../agui/reducer';
import { threadTitle } from '../state/tab';

export interface ThreadListProps {
  threads: ThreadState[];
  activeThreadId: string;
  onSelect: (threadId: string) => void;
  onNew: () => void;
}

/** This tab's threads. Other tabs keep their own. */
export const ThreadList = ({ threads, activeThreadId, onSelect, onNew }: ThreadListProps) => (
  <nav aria-label="Threads in this tab" className="flex flex-col gap-2">
    <Button
      type="button"
      variant="outline"
      leftSection={<LuPlus aria-hidden focusable="false" />}
      onClick={onNew}
    >
      New thread
    </Button>
    <ul className="flex flex-col gap-1">
      {threads.map((thread) => {
        const active = thread.threadId === activeThreadId;
        return (
          <li key={thread.threadId}>
            <UnstyledButton
              aria-current={active ? 'true' : undefined}
              onClick={() => onSelect(thread.threadId)}
              className={`w-full truncate rounded px-2 py-1 text-left text-sm ${
                active ? 'bg-base-lightest font-semibold' : 'hover:bg-base-lightest'
              }`}
            >
              {threadTitle(thread)}
            </UnstyledButton>
          </li>
        );
      })}
    </ul>
  </nav>
);
