import React from 'react';
import { LuInfo } from 'react-icons/lu';
import type { RunState, ThreadNotice } from '../agui/reducer';
import { noticeText } from '../notices';
import { RunItem } from './RunItem';

export interface ThreadViewProps {
  runs: RunState[];
  running: boolean;
  onStop: () => void;
  onOpenApp: (appId: string) => void;
  /** The last rejected turn, shown after the runs. */
  notice?: ThreadNotice | null;
}

/**
 * The conversation as an ARIA log. Its own live announcements are off: one polite
 * region beside it announces step changes, answers and notices, so nothing is read twice.
 */
export const ThreadView = ({ runs, running, onStop, onOpenApp, notice = null }: ThreadViewProps) => {
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape' || !running) return;
    // ProteinPaint's menus inside a viewer use Esc themselves.
    if ((event.target as Element).closest('[data-orion-viz]')) return;
    event.preventDefault();
    onStop();
  };

  return (
    <div
      role="log"
      aria-live="off"
      aria-label="Conversation"
      tabIndex={0}
      onKeyDown={onKeyDown}
      className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
    >
      {runs.map((run) => (
        <RunItem key={run.runId} run={run} onOpenApp={onOpenApp} />
      ))}
      {notice && (
        <p role="note" className="inline-flex items-center gap-1 text-sm">
          <LuInfo aria-hidden focusable="false" className="shrink-0" />
          {noticeText(notice)}
        </p>
      )}
    </div>
  );
};
