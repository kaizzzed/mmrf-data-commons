import React, {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import Router from 'next/router';
import { isInvocationActive, type ThreadNotice, type ThreadState } from './agui/reducer';
import { selectTransport, type RunTransport } from './agui/transport';
import { useCohortContext } from './cohort/useCohortContext';
import { Composer } from './components/Composer';
import { Starters } from './components/Starters';
import { ThreadList } from './components/ThreadList';
import { ThreadView } from './components/ThreadView';
import { FIXTURE_NOTICE, SYNTHETIC_NOTICE } from './constants';
import { useRunController } from './controller/useRunController';
import { formatScope } from './format';
import { newId } from './ids';
import { noticeText } from './notices';
import { describeRunChange } from './state/announce';
import { loadTab, saveTab } from './state/storage';
import { activeThread, createTab, tabReducer, threadRuns, type TabState } from './state/tab';

// Day 1 spike only (`spike=pp`); loads ProteinPaint just for that URL.
const PpSpike = lazy(() => import('./viz/spike/PpSpike'));

/**
 * Polite announcements for the thread on screen: run changes and rejection notices.
 * Switching threads says nothing.
 */
const useRunAnnouncements = (thread: ThreadState): string => {
  const previous = useRef(thread);
  const [message, setMessage] = useState('');
  useEffect(() => {
    const prev = previous.current;
    previous.current = thread;
    if (prev === thread || prev.threadId !== thread.threadId) return;
    const parts = thread.runIds
      .filter((id) => prev.runs[id] !== thread.runs[id])
      .map((id) => describeRunChange(prev.runs[id], thread.runs[id]))
      .filter((part): part is string => part !== null);
    if (thread.notice && thread.notice !== prev.notice) parts.push(noticeText(thread.notice));
    if (parts.length > 0) setMessage(parts.join(' '));
  }, [thread]);
  return message;
};

/**
 * Puts a rejected question back in the composer once, when its thread is on screen, unless
 * something has been typed since. Notices restored from storage were handled before the reload.
 */
const useRestoreRejectedQuestion = (
  tab: TabState,
  setDraft: Dispatch<SetStateAction<string>>,
): void => {
  const [handled] = useState(
    () => new WeakSet<ThreadNotice>(tab.threadIds.flatMap((id) => tab.threads[id].notice ?? [])),
  );
  const { notice } = activeThread(tab);
  useEffect(() => {
    if (!notice || handled.has(notice)) return;
    handled.add(notice);
    const { question } = notice;
    if (question) setDraft((draft) => (draft.trim() ? draft : question));
  }, [notice, handled, setDraft]);
};

/** Same-tab hand-off: the platform opens the app on its active cohort. */
const openAppInThisTab = (appId: string): void => {
  void Router.push({ pathname: '/', query: { app: appId } });
};

export interface AssistantAppProps {
  /** Defaults to the transport the page URL selects (`orion=fixture` replays the J1 stub). */
  transport?: RunTransport;
  /** Defaults to a same-tab navigation to `/?app=<appId>`. */
  openApp?: (appId: string) => void;
}

const AssistantApp = ({ transport: injected, openApp = openAppInThisTab }: AssistantAppProps) => {
  const transport = useMemo(
    () => injected ?? selectTransport(typeof window === 'undefined' ? '' : window.location.search),
    [injected],
  );
  // Restored synchronously, so strict mode's double effects cannot clobber it.
  const [tab, dispatch] = useReducer(tabReducer, null, () => loadTab() ?? createTab(newId()));
  const controller = useRunController(transport, dispatch);
  const cohortContext = useCohortContext();
  const [draft, setDraft] = useState('');
  const [ppSpike] = useState(
    () => typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('spike') === 'pp',
  );
  const composerRef = useRef<HTMLTextAreaElement>(null);

  const thread = activeThread(tab);
  const runs = threadRuns(thread);
  const running = isInvocationActive(thread);
  const announcement = useRunAnnouncements(thread);
  useRestoreRejectedQuestion(tab, setDraft);
  const { active } = cohortContext;

  useEffect(() => saveTab(tab), [tab]);
  useEffect(() => controller.warmup(thread.threadId), [controller, thread.threadId]);

  const ask = (text: string) => {
    const question = text.trim();
    if (!question || running) return;
    controller.ask(thread.threadId, question, cohortContext);
    setDraft('');
  };

  const stop = () => {
    const run = thread.invocation ? thread.runs[thread.invocation.runId] : undefined;
    if (running && run && !run.stopRequested) controller.stop(thread.threadId, run.runId);
  };

  return (
    <div className="flex w-full flex-col gap-4 p-4 md:flex-row" data-testid="orion-assistant">
      <aside className="md:w-60 md:shrink-0">
        <ThreadList
          threads={tab.threadIds.map((id) => tab.threads[id])}
          activeThreadId={tab.activeThreadId}
          onSelect={(threadId) => dispatch({ type: 'selectThread', threadId })}
          onNew={() => {
            // An unused thread is already new; do not stack empty ones.
            if (runs.length > 0) dispatch({ type: 'newThread', threadId: newId() });
            composerRef.current?.focus();
          }}
        />
      </aside>
      <section aria-label="ORION Assistant" className="flex min-w-0 flex-1 flex-col gap-4">
        <div role="note" className="rounded-md bg-amber-100 p-2 text-sm text-amber-950">
          {SYNTHETIC_NOTICE}
        </div>
        {transport.replay && (
          <div
            role="note"
            className="rounded-md border border-amber-700 bg-amber-50 p-2 text-sm font-medium text-amber-950"
          >
            {FIXTURE_NOTICE}
          </div>
        )}
        {ppSpike && (
          <Suspense fallback={null}>
            <PpSpike />
          </Suspense>
        )}
        {runs.length === 0 && <Starters onPick={ask} />}
        <ThreadView
          runs={runs}
          running={running}
          onStop={stop}
          onOpenApp={openApp}
          notice={thread.notice}
        />
        <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
          {announcement}
        </div>
        <Composer
          ref={composerRef}
          value={draft}
          onChange={setDraft}
          onSend={() => ask(draft)}
          onStop={stop}
          running={running}
          scopeLabel={formatScope(active.name, active.caseCount)}
        />
      </section>
    </div>
  );
};

export default AssistantApp;
