import React, {
  lazy,
  Suspense,
  useEffect,
  useId,
  useMemo,
  useReducer,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import Router from 'next/router';
import {
  activeRunId,
  isEndStatus,
  isInvocationActive,
  isWaitingStatus,
  latestRunId,
  type RunState,
  type ThreadNotice,
  type ThreadState,
} from './agui/reducer';
import { selectTransport, type RunTransport } from './agui/transport';
import type { AppId, ConfirmPending, EditPlanAction, SaveCohortsArgs } from './agui/types';
import type { PlanEdit, ScopeOption } from './cards/PlanEdits';
import type { CohortPort } from './cohort/cohortPort';
import { dontSaveAction, SaveCohortsError, saveCohorts } from './cohort/saveCohorts';
import { ledgerProgress, localLedgerStore, type LedgerStore } from './cohort/saveLedger';
import { SetActiveCohortError, setActiveCohort } from './cohort/setActiveCohort';
import { useCohortContext } from './cohort/useCohortContext';
import { useCohortPort } from './cohort/useCohortPort';
import { writeLog, type WriteLog } from './cohort/writeLog';
import { Composer } from './components/Composer';
import { PausePrompt } from './components/PausePrompt';
import { RunActionsContext, type RunActions, type SaveState } from './components/RunActions';
import type { ScopeChipOption } from './components/ScopeChip';
import { Starters } from './components/Starters';
import { ThreadList } from './components/ThreadList';
import { ThreadView } from './components/ThreadView';
import { FIXTURE_NOTICE, SYNTHETIC_NOTICE } from './constants';
import { useRunController, type ResumeAction, type ResumeExpectation } from './controller/useRunController';
import { formatScope } from './format';
import { handoffTarget, openInTool } from './handoff/handoff';
import { mantineNotifier, type Notifier } from './handoff/notifier';
import { newId } from './ids';
import { EvidenceInspector, type InspectorTarget } from './inspector/EvidenceInspector';
import { noticeText } from './notices';
import { describeRunChange } from './state/announce';
import { loadTab, saveTab } from './state/storage';
import { activeThread, createTab, tabReducer, threadRuns, type TabState } from './state/tab';
import { DEFAULT_VIZ_SERVICES, VizServicesContext, type VizServices } from './viz/vizServices';

// Day 1 spike only (`spike=pp` with NEXT_PUBLIC_ORION_SPIKE=1); loads ProteinPaint just for that page.
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

const errorText = (err: unknown): string => (err instanceof Error ? err.message : 'Something went wrong');

/**
 * The save_cohorts args for a confirmation: the TOOL_CALL_ARGS payload of this nonce, else the
 * snapshot's pending when no definition was trimmed from it; null when the view route must fill in.
 */
const saveArgsOf = (run: RunState, pending: ConfirmPending): SaveCohortsArgs | null => {
  const call = run.toolCalls.find((c) => c.id === pending.nonce && c.name === 'save_cohorts' && c.ended);
  if (call) {
    try {
      const args = JSON.parse(call.args) as SaveCohortsArgs;
      if (
        args.nonce === pending.nonce &&
        args.planSignature === pending.planSignature &&
        args.cohorts.every((c) => c.definition !== null)
      ) {
        return args;
      }
    } catch {
      // A torn payload: fall back to the snapshot or the view route.
    }
  }
  return pending.cohorts.every((c) => c.definition !== null) ? (pending as SaveCohortsArgs) : null;
};

const expectationOf = (run: RunState): ResumeExpectation => {
  const pending = run.view?.pending;
  return { status: run.view?.status ?? run.status, nonce: pending?.kind === 'confirm' ? pending.nonce : null };
};

export interface AssistantAppProps {
  /** Defaults to the transport the page URL selects (`orion=fixture` replays the J1 stub). */
  transport?: RunTransport;
  /** Defaults to a same-tab navigation to `/?app=<appId>`. */
  openApp?: (appId: string) => void;
  /** Defaults to the platform's cohort store (CoreProvider's). */
  cohorts?: CohortPort;
  /** Defaults to the save ledger in localStorage. */
  ledger?: LedgerStore;
  /** Defaults to the platform's notifications. */
  notifier?: Notifier;
  /** Defaults to the page's client-write log. */
  log?: WriteLog;
}

const NO_SAVE: SaveState = { progress: null, saving: false, error: null };

const AssistantMain = ({
  transport: injected,
  openApp = openAppInThisTab,
  cohorts,
  ledger: injectedLedger,
  notifier = mantineNotifier,
  log = writeLog,
}: AssistantAppProps) => {
  const transport = useMemo(
    () => injected ?? selectTransport(typeof window === 'undefined' ? '' : window.location.search),
    [injected],
  );
  // Restored synchronously, so strict mode's double effects cannot clobber it.
  const [tab, dispatch] = useReducer(tabReducer, null, () => loadTab() ?? createTab(newId()));
  const controller = useRunController(transport, dispatch);
  const cohortContext = useCohortContext();
  const storePort = useCohortPort();
  const port = cohorts ?? storePort;
  const ledger = useMemo(() => injectedLedger ?? localLedgerStore(), [injectedLedger]);
  const [draft, setDraft] = useState('');
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [inspector, setInspector] = useState<InspectorTarget | null>(null);
  const inspectorReturn = useRef<HTMLElement | null>(null);
  const [pause, setPause] = useState<{ question: string; runId: string; fromComposer: boolean } | null>(null);
  const [saves, setSaves] = useState<Record<string, { saving: boolean; error: string | null }>>({});
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const titleId = useId();
  const restored = useRef(new Set<string>());

  const thread = activeThread(tab);
  const { threadId } = thread;
  const runs = threadRuns(thread);
  const latest = latestRunId(thread);
  const latestRun = latest ? thread.runs[latest] : undefined;
  const stopRunId =
    activeRunId(thread) ??
    (latestRun?.stopRequested && latestRun.status === 'Stopping' ? latestRun.runId : null);
  const running = stopRunId !== null;
  const busyRunId = isInvocationActive(thread) && thread.invocation ? thread.invocation.runId : null;
  /** A cancel turn for the run is on its way: Stop waits. When that turn failed, Stop can go again. */
  const cancelInFlight = busyRunId !== null && busyRunId === stopRunId && thread.invocation?.kind === 'cancel';
  const stopping = running && cancelInFlight;
  const announcement = useRunAnnouncements(thread);
  useRestoreRejectedQuestion(tab, setDraft);
  const { active } = cohortContext;

  useEffect(() => saveTab(tab), [tab]);
  useEffect(() => controller.warmup(threadId), [controller, threadId]);
  useEffect(() => {
    restored.current = new Set();
  }, [controller]);
  useEffect(() => {
    // On return the view route reloads each run of the thread on screen: the record wins.
    if (restored.current.has(threadId)) return;
    restored.current.add(threadId);
    const current = activeThread(tab);
    controller.restore(threadId, current.runIds, latestRunId(current));
    // Only a thread coming on screen is restored, not every change to it, so `tab` is read, not tracked.
  }, [controller, threadId]);

  const handoffDeps = useMemo(
    () => ({ port, log, notify: notifier, navigate: (appId: AppId) => openApp(appId) }),
    [port, log, notifier, openApp],
  );

  /** A Stop no snapshot has confirmed yet goes again ahead of the next turn (design "Data model"). */
  const resendStops = () => {
    for (const run of runs) {
      if (run.stopRequested && run.status === 'Stopping' && busyRunId !== run.runId) {
        controller.resendStop(threadId, run.runId);
      }
    }
  };

  const ask = (question: string, cancelWaiting: string | undefined, fromComposer: boolean) => {
    resendStops();
    controller.ask(threadId, question, cohortContext, cancelWaiting ? { cancelWaiting } : {});
    if (fromComposer) setDraft('');
    setPause(null);
  };

  const send = (text: string, fromComposer: boolean) => {
    const question = text.trim();
    if (!question || running) return;
    if (latestRun && isWaitingStatus(latestRun.status)) {
      // A thread never holds two unfinished runs: ask once what to do with the waiting one.
      setPause({ question, runId: latestRun.runId, fromComposer });
      return;
    }
    ask(question, undefined, fromComposer);
  };

  const stop = () => {
    const run = stopRunId ? thread.runs[stopRunId] : undefined;
    if (!run || isEndStatus(run.status)) return;
    if (!run.stopRequested) controller.stop(threadId, run.runId);
    // The first cancel's turn failed before a snapshot showed the run Cancelled: send it again.
    else if (!cancelInFlight) controller.resendStop(threadId, run.runId);
  };

  const resume = (run: RunState, action: ResumeAction) => {
    resendStops();
    controller.resume(threadId, run.runId, action, expectationOf(run));
  };

  const setSave = (nonce: string, state: { saving: boolean; error: string | null }) =>
    setSaves((all) => ({ ...all, [nonce]: state }));

  /** Create: bound to the card's nonce and plan signature; the writes run inside this click. */
  const create = (run: RunState, pending: ConfirmPending, makeActive: string | null) => {
    const current = thread.runs[run.runId]?.view?.pending;
    if (current?.kind !== 'confirm' || current.nonce !== pending.nonce || current.planSignature !== pending.planSignature) {
      return;
    }
    const finish = (args: SaveCohortsArgs) => {
      try {
        const result = saveCohorts({ args, makeActive, threadId, runId: run.runId }, { port, ledger, log });
        if (result.activated) {
          const name = result.confirm.saved.find((s) => s.ref === makeActive)?.name ?? 'The saved cohort';
          notifier.undo(`Active cohort: ${name}.`, result.activated.undo);
        }
        setSave(pending.nonce, { saving: false, error: null });
        resume(run, result.confirm);
      } catch (err) {
        const message =
          err instanceof SaveCohortsError || err instanceof SetActiveCohortError
            ? err.message
            : `Saving stopped: ${errorText(err)}`;
        setSave(pending.nonce, { saving: false, error: `${message}. Nothing was sent to ORION; try Create again.` });
      }
    };
    const args = saveArgsOf(run, pending);
    if (args) {
      finish(args);
      return;
    }
    // The snapshot was trimmed to fit 32 KB and no tool call carried the definitions: the view
    // route has them untrimmed. The save still belongs to this click.
    if (!controller.routes) {
      setSave(pending.nonce, { saving: false, error: 'The cohort definitions are missing, so nothing was saved.' });
      return;
    }
    setSave(pending.nonce, { saving: true, error: null });
    controller.routes.view(run.runId, threadId).then(
      (view) => {
        const fresh = view.pending?.kind === 'confirm' && view.pending.nonce === pending.nonce ? view.pending : null;
        const full = fresh && fresh.cohorts.every((c) => c.definition !== null) ? (fresh as SaveCohortsArgs) : null;
        if (full) finish(full);
        else setSave(pending.nonce, { saving: false, error: "This confirmation is no longer the run's pending one." });
      },
      (err: unknown) =>
        setSave(pending.nonce, { saving: false, error: `The cohort definitions could not be read: ${errorText(err)}` }),
    );
  };

  const inspect = (target: InspectorTarget) => {
    if (!inspector) inspectorReturn.current = document.activeElement as HTMLElement | null;
    setInspector(target);
  };

  const closeInspector = () => {
    setInspector(null);
    const back = inspectorReturn.current;
    inspectorReturn.current = null;
    if (back?.isConnected) back.focus();
    else composerRef.current?.focus();
  };

  const switchScope = (option: ScopeChipOption) => {
    try {
      const outcome = setActiveCohort(
        port,
        { cohortId: option.cohortId, name: option.name, origin: 'scope_chip' },
        { threadId, runId: null, stepId: null },
        log,
      );
      if (outcome.changed) notifier.undo(`Active cohort: ${option.name}.`, outcome.undo);
    } catch (err) {
      notifier.error(errorText(err));
    }
  };

  const scopeOptions: ScopeOption[] = [
    { label: 'All cases', choice: { source: 'all_cases' } },
    { label: `Active cohort: ${active.name}`, choice: { source: 'active_cohort' } },
    ...cohortContext.saved.map((c): ScopeOption => ({ label: c.name, choice: { source: 'saved_cohort', cohortName: c.name } })),
  ];
  const chipOptions: ScopeChipOption[] = cohortContext.saved
    .filter((c) => c.id !== active.id)
    .map((c) => ({ cohortId: c.id, name: c.name, caseCount: c.caseCount, allCases: Object.keys(c.filters.root).length === 0 }));

  const actions: RunActions = {
    threadId,
    latestRunId: latest,
    busyRunId,
    composerHasText: () => draftRef.current.trim().length > 0,
    scopeOptions,
    askFollowUp: (followUp) => send(followUp.question, false),
    clarify: (run, optionId) => resume(run, { action: 'clarify_answer', optionId }),
    cancel: (run) => controller.stop(threadId, run.runId),
    consent: (run, accept) => resume(run, { action: 'consent', accept }),
    create,
    dontSave: (run, pending) => resume(run, dontSaveAction(pending.nonce)),
    edit: (run, edit: PlanEdit) => {
      const action = (
        edit.field === 'scope'
          ? { action: 'edit_plan', ...edit, cohortContext }
          : { action: 'edit_plan', ...edit }
      ) as EditPlanAction;
      resume(run, action);
    },
    retry: (run, stepId) => resume(run, { action: 'retry_step', stepId }),
    inspect,
    openOnCohort: (run, appId, cohortRefs) => {
      const target = run.view ? handoffTarget(run.view, cohortRefs) : { cohortId: null, cohortName: null, disabledReason: null };
      if (target.disabledReason) return;
      openInTool(handoffDeps, { appId, cohortId: target.cohortId, cohortName: target.cohortName, threadId, runId: run.runId });
    },
    openInTool: (run, spec, appId, cohortId) => {
      // Don't save turns hand-off off for cards pinned to the unsaved groups (C-16).
      if (run.view && handoffTarget(run.view, spec.cohortRefs).disabledReason) return;
      openInTool(handoffDeps, { appId, cohortId, threadId, runId: run.runId });
    },
    openLink: (link) => openApp(link.appId),
    reportViz: (report) => controller.reportViz(threadId, report),
    loadUntrimmedSpec: (runId, vizId) => controller.loadSpec(threadId, runId, vizId),
    saveState: (nonce) => {
      const state = saves[nonce];
      const progress = ledgerProgress(ledger.read(nonce));
      return state || progress ? { progress, saving: state?.saving ?? false, error: state?.error ?? null } : NO_SAVE;
    },
  };

  const vizServices = useMemo<VizServices>(
    () => ({ ...DEFAULT_VIZ_SERVICES, activeCohortId: active.id }),
    [active.id],
  );

  return (
    <VizServicesContext.Provider value={vizServices}>
      <RunActionsContext.Provider value={actions}>
        <div className="flex w-full flex-col gap-4 p-4 md:flex-row" data-testid="orion-assistant">
          <aside className="md:w-60 md:shrink-0">
            <ThreadList
              threads={tab.threadIds.map((id) => tab.threads[id])}
              activeThreadId={tab.activeThreadId}
              onSelect={(id) => {
                setInspector(null);
                setPause(null);
                dispatch({ type: 'selectThread', threadId: id });
              }}
              onNew={() => {
                // An unused thread is already new; do not stack empty ones.
                if (runs.length > 0) dispatch({ type: 'newThread', threadId: newId() });
                setInspector(null);
                setPause(null);
                composerRef.current?.focus();
              }}
            />
          </aside>
          <section aria-labelledby={titleId} className="flex min-w-0 flex-1 flex-col gap-4">
            <h2 id={titleId} className="sr-only">
              ORION Assistant
            </h2>
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
            {runs.length === 0 && <Starters onPick={(prompt) => send(prompt, false)} />}
            <ThreadView runs={runs} running={running} onStop={stop} notice={thread.notice} />
            <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
              {announcement}
            </div>
            {pause && (
              <PausePrompt
                onCancelAndSend={() => ask(pause.question, pause.runId, pause.fromComposer)}
                onKeepWaiting={() => {
                  setPause(null);
                  composerRef.current?.focus();
                }}
              />
            )}
            <Composer
              ref={composerRef}
              value={draft}
              onChange={setDraft}
              onSend={() => send(draft, true)}
              onStop={stop}
              running={running}
              stopping={stopping}
              scopeLabel={formatScope(active.name, active.caseCount)}
              scopeOptions={chipOptions}
              onSwitchScope={switchScope}
            />
          </section>
          {inspector && (
            <EvidenceInspector
              threadId={threadId}
              target={inspector}
              run={thread.runs[inspector.runId]}
              routes={controller.routes}
              onSelect={setInspector}
              onClose={closeInspector}
            />
          )}
        </div>
      </RunActionsContext.Provider>
    </VizServicesContext.Provider>
  );
};

/** The ?spike=pp page renders only when NEXT_PUBLIC_ORION_SPIKE is "1"; otherwise the Assistant does. */
export const spikeRequested = (search: string): boolean =>
  process.env.NEXT_PUBLIC_ORION_SPIKE === '1' && new URLSearchParams(search).get('spike') === 'pp';

const AssistantApp = (props: AssistantAppProps) => {
  const [spike] = useState(() => typeof window !== 'undefined' && spikeRequested(window.location.search));
  if (spike) {
    return (
      <div className="flex w-full flex-col gap-4 p-4" data-testid="orion-spike">
        <div role="note" className="rounded-md bg-amber-100 p-2 text-sm text-amber-950">
          {SYNTHETIC_NOTICE}
        </div>
        <Suspense fallback={<p className="text-sm">Loading the viewer spike…</p>}>
          <PpSpike />
        </Suspense>
      </div>
    );
  }
  return <AssistantMain {...props} />;
};

export default AssistantApp;
