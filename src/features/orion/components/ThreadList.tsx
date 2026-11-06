import React, { useEffect, useId, useRef, useState } from 'react';
import { ActionIcon, Button, Modal, Tooltip, UnstyledButton } from '@mantine/core';
import { LuPlus, LuTrash2 } from 'react-icons/lu';
import type { ThreadState } from '../agui/reducer';
import { nothingToDelete, threadTitle } from '../state/tab';

export interface ThreadListProps {
  threads: ThreadState[];
  activeThreadId: string;
  onSelect: (threadId: string) => void;
  onNew: () => void;
  /** The researcher confirmed; the thread stays if a run started on it meanwhile. */
  onDelete: (threadId: string) => void;
  /**
   * Why the thread cannot be deleted now, said as a state ("Can't delete while …"), or null. It is
   * the delete control's description and its tooltip, and the dialog says it if it comes up there.
   */
  deleteBlocked?: (thread: ThreadState) => string | null;
}

export const DELETE_THREAD_TITLE = 'Delete this thread?';

/** A question can run to 4,000 characters; the delete control and its dialog quote this much of it. */
export const QUOTED_TITLE_CHARS = 80;

/** The thread's title cut to QUOTED_TITLE_CHARS characters (whole code points), with "…" when cut. */
export const quotedTitle = (thread: ThreadState): string => {
  const chars = Array.from(threadTitle(thread));
  return chars.length <= QUOTED_TITLE_CHARS ? chars.join('') : `${chars.slice(0, QUOTED_TITLE_CHARS - 1).join('').trimEnd()}…`;
};

export const deleteThreadLabel = (thread: ThreadState): string => `Delete thread: ${quotedTitle(thread)}`;

/** What the dialog says will happen, after the quoted title. */
export const DELETE_THREAD_CONSEQUENCES =
  "will be removed from this tab. This can't be undone. Cohorts you saved and the run records on the server are not affected.";

const NEVER_BLOCKED = (): null => null;

const focusable = (el: HTMLButtonElement | null | undefined): el is HTMLButtonElement =>
  !!el && el.isConnected && !el.disabled;

/**
 * This tab's threads. Other tabs keep their own. Deleting one asks first and removes it from
 * this tab only: the cohorts it saved and its run records stay. While a thread cannot be deleted,
 * its control stays focusable but off (aria-disabled), and says why on hover or focus.
 */
export const ThreadList = ({
  threads,
  activeThreadId,
  onSelect,
  onNew,
  onDelete,
  deleteBlocked = NEVER_BLOCKED,
}: ThreadListProps) => {
  const [open, setOpen] = useState(false);
  /** The thread the dialog asks about; kept while it closes, so its text stays put. */
  const [subject, setSubject] = useState<{ threadId: string; title: string } | null>(null);
  /** Set when the dialog closes: the thread it asked about, whose fate decides where focus goes. */
  const focusAfter = useRef<string | null>(null);
  const rows = useRef(new Map<string, HTMLButtonElement>());
  const deletes = useRef(new Map<string, HTMLButtonElement>());
  /** One ref callback per element for good: a new one each render would detach and reattach it. */
  const refCallbacks = useRef(new Map<string, (el: HTMLButtonElement | null) => void>());
  const newRef = useRef<HTMLButtonElement>(null);
  const baseId = useId();

  const target = open && subject ? threads.find((t) => t.threadId === subject.threadId) : undefined;
  const blockedNow = target ? deleteBlocked(target) : null;

  // After the dialog closes: back on the control that opened it when the thread stays (Cancel,
  // Escape, a delete the tab refused), else on the thread now active, else on New thread.
  useEffect(() => {
    const threadId = focusAfter.current;
    if (threadId === null) return;
    focusAfter.current = null;
    const stays = threads.some((t) => t.threadId === threadId);
    const candidates = stays
      ? [deletes.current.get(threadId), rows.current.get(threadId)]
      : [rows.current.get(activeThreadId)];
    [...candidates, newRef.current].find(focusable)?.focus();
  });

  const ask = (thread: ThreadState) => {
    setSubject({ threadId: thread.threadId, title: quotedTitle(thread) });
    setOpen(true);
  };

  const close = () => {
    focusAfter.current = subject?.threadId ?? null;
    setOpen(false);
  };

  const confirm = () => {
    if (!target || blockedNow) return;
    close();
    onDelete(target.threadId);
  };

  const keep = (kind: 'row' | 'delete', threadId: string) => {
    const key = `${kind}:${threadId}`;
    const known = refCallbacks.current.get(key);
    if (known) return known;
    const map = kind === 'row' ? rows : deletes;
    const callback = (el: HTMLButtonElement | null) => {
      if (el) map.current.set(threadId, el);
      else map.current.delete(threadId);
    };
    refCallbacks.current.set(key, callback);
    return callback;
  };

  return (
    <nav aria-label="Threads in this tab" className="flex flex-col gap-2">
      <Button
        ref={newRef}
        type="button"
        variant="outline"
        leftSection={<LuPlus aria-hidden focusable="false" />}
        onClick={onNew}
      >
        New thread
      </Button>
      <ul className="flex flex-col gap-1">
        {threads.map((thread) => {
          const { threadId } = thread;
          const active = threadId === activeThreadId;
          const offered = !nothingToDelete(threads.length, thread);
          const blocked = offered ? deleteBlocked(thread) : null;
          const reasonId = `${baseId}-${threadId}-blocked`;
          return (
            <li key={threadId} className="flex items-center gap-1">
              <UnstyledButton
                ref={keep('row', threadId)}
                aria-current={active ? 'true' : undefined}
                onClick={() => onSelect(threadId)}
                className={`min-w-0 flex-1 truncate rounded px-2 py-1 text-left text-sm ${
                  active ? 'bg-base-lightest font-semibold' : 'hover:bg-base-lightest'
                }`}
              >
                {threadTitle(thread)}
              </UnstyledButton>
              {offered && (
                // Not `disabled`: a disabled button takes no hover or focus, so it could not say why.
                <Tooltip
                  label={blocked}
                  disabled={blocked === null}
                  events={{ hover: true, focus: true, touch: true }}
                  position="right"
                  withArrow
                >
                  <ActionIcon
                    ref={keep('delete', threadId)}
                    type="button"
                    variant="subtle"
                    color="gray"
                    aria-label={deleteThreadLabel(thread)}
                    aria-disabled={blocked !== null || undefined}
                    aria-describedby={blocked ? reasonId : undefined}
                    data-disabled={blocked !== null || undefined}
                    onClick={() => {
                      if (blocked === null) ask(thread);
                    }}
                  >
                    <LuTrash2 aria-hidden focusable="false" />
                  </ActionIcon>
                </Tooltip>
              )}
              {blocked && (
                <span id={reasonId} className="sr-only">
                  {blocked}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {/* Built from its parts so the description (Modal.Body) is the copy alone, not the buttons. */}
      <Modal.Root
        opened={target !== undefined}
        onClose={close}
        returnFocus={false}
        centered
        size="sm"
        // Above the platform's sticky header (z-index 375), as the cohort modals are.
        zIndex={400}
      >
        <Modal.Overlay />
        <Modal.Content>
          <Modal.Header>
            <Modal.Title>{DELETE_THREAD_TITLE}</Modal.Title>
          </Modal.Header>
          <Modal.Body>
            <p className="text-sm [overflow-wrap:anywhere]">
              &ldquo;{subject?.title}&rdquo; {DELETE_THREAD_CONSEQUENCES}
            </p>
            {blockedNow && <p className="mt-2 text-sm font-semibold">{blockedNow}</p>}
          </Modal.Body>
          <div className="flex justify-end gap-2 px-4 pb-4">
            <Button type="button" variant="default" onClick={close} data-autofocus>
              Cancel
            </Button>
            <Button type="button" color="red" onClick={confirm} disabled={blockedNow !== null}>
              Delete
            </Button>
          </div>
        </Modal.Content>
      </Modal.Root>
    </nav>
  );
};
