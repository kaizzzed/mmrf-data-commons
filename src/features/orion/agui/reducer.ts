import type { SseParseError } from './sseParser';
import {
  END_STATUSES,
  LEASED_STATUSES,
  REJECTION_CODES,
  WAITING_STATUSES,
  type AguiEvent,
  type BffErrorCode,
  type OrionActionName,
  type OrionCode,
  type RejectionCode,
  type RunStatus,
  type RunView,
  type Step,
  type StepStatus,
} from './types';

export type RunFlag = 'DOUBLE_TERMINAL' | 'UNKNOWN_STEP';
export type ThreadFlag = 'ORPHAN_EVENT' | 'FOREIGN_THREAD' | 'UNKNOWN_RUN';

export interface TransportFailure {
  code: string;
  message: string;
}

export interface ToolCallState {
  id: string;
  name: string;
  args: string;
  ended: boolean;
}

export interface TextMessageState {
  id: string;
  text: string;
  ended: boolean;
}

export interface RunState {
  runId: string;
  question: string;
  submittedAt: string | null;
  started: boolean;
  /** The snapshot's status, overridden by terminal events and a pending stop. */
  status: RunStatus;
  code: OrionCode | null;
  errorMessage: string | null;
  view: RunView | null;
  stopRequested: boolean;
  lastHeartbeatAt: string | null;
  toolCalls: ToolCallState[];
  messages: TextMessageState[];
  transportError: TransportFailure | null;
  protocolErrors: SseParseError[];
  flags: RunFlag[];
}

/** What opened an invocation: a question, a Stop, or any other turn (a resume, a stream joined). */
export type InvocationKind = 'ask' | 'cancel' | 'other';

/** One POST and its stream. Exactly one terminal event ends it. */
export interface Invocation {
  runId: string;
  kind: InvocationKind;
  terminal: boolean;
  closed: boolean;
  /** The action the turn sent; absent for a stream the browser did not start here. */
  action?: OrionActionName;
}

/** Why a turn was turned away: an agent rejection, or the BFF's own error code. */
export type NoticeCode = RejectionCode | BffErrorCode;

/** A turn the server rejected. It created no run and changed none. */
export interface ThreadNotice {
  code: NoticeCode;
  message: string;
  turn: InvocationKind;
  /** The question of the run the rejection took back, for the composer; null if none was. */
  question: string | null;
  action?: OrionActionName;
}

export interface ThreadState {
  threadId: string;
  runIds: string[];
  runs: Record<string, RunState>;
  invocation: Invocation | null;
  /** The last rejected turn, until the browser sends the next one. */
  notice: ThreadNotice | null;
  flags: ThreadFlag[];
}

export type LocalAction =
  | { type: 'submit'; runId: string; question: string; at: string }
  | { type: 'stop'; runId: string }
  /** A turn leaving the browser: its stream is the one id-less events now belong to. */
  | { type: 'turn'; runId: string; kind: InvocationKind; action: OrionActionName }
  /** Stop before the ask left the browser: no turn reached the server, so none reports the end. */
  | { type: 'withdraw'; runId: string }
  /**
   * The turn's stream failed. With `checking`, the browser reads the view route next, so a run
   * that never started is not shown Failed in the meantime.
   */
  | { type: 'transportError'; runId: string; code: string; message: string; checking?: boolean }
  | { type: 'protocolError'; runId: string; error: SseParseError }
  /** The view route's copy of a run: the record wins (revision permitting), status included. */
  | { type: 'view'; view: RunView }
  /** A turn the BFF turned away, or one the view route showed never started. */
  | { type: 'turnRejected'; runId: string; code: NoticeCode; message: string }
  /** The view route has no such run (restore): it leaves the thread. */
  | { type: 'dropRun'; runId: string }
  /** The view route answered for a turn whose stream never ended it: the turn is over. */
  | { type: 'turnSettled'; runId: string };

export type ThreadAction = AguiEvent | LocalAction;

const END: ReadonlySet<RunStatus> = new Set(END_STATUSES);
export const isEndStatus = (status: RunStatus): boolean => END.has(status);

const WAITING: ReadonlySet<RunStatus> = new Set(WAITING_STATUSES);
export const isWaitingStatus = (status: RunStatus): boolean => WAITING.has(status);

const LEASED: ReadonlySet<RunStatus> = new Set(LEASED_STATUSES);
export const isLeasedStatus = (status: RunStatus): boolean => LEASED.has(status);

const REJECTIONS: ReadonlySet<OrionCode> = new Set(REJECTION_CODES);
export const isRejectionCode = (code: OrionCode): code is RejectionCode => REJECTIONS.has(code);

export const createThread = (threadId: string): ThreadState => ({
  threadId,
  runIds: [],
  runs: {},
  invocation: null,
  notice: null,
  flags: [],
});

const createRun = (runId: string, question = '', submittedAt: string | null = null): RunState => ({
  runId,
  question,
  submittedAt,
  started: false,
  status: 'Planning',
  code: null,
  errorMessage: null,
  view: null,
  stopRequested: false,
  lastHeartbeatAt: null,
  toolCalls: [],
  messages: [],
  transportError: null,
  protocolErrors: [],
  flags: [],
});

const addFlag = <T extends string>(flags: T[], flag: T): T[] =>
  flags.includes(flag) ? flags : [...flags, flag];

const flagThread = (state: ThreadState, flag: ThreadFlag): ThreadState =>
  state.flags.includes(flag) ? state : { ...state, flags: addFlag(state.flags, flag) };

const putRun = (state: ThreadState, run: RunState): ThreadState => ({
  ...state,
  runIds: state.runIds.includes(run.runId) ? state.runIds : [...state.runIds, run.runId],
  runs: { ...state.runs, [run.runId]: run },
});

const dropRun = (state: ThreadState, runId: string): ThreadState => {
  const runs = { ...state.runs };
  delete runs[runId];
  return { ...state, runIds: state.runIds.filter((id) => id !== runId), runs };
};

const openInvocation = (runId: string, kind: InvocationKind, action?: OrionActionName): Invocation => ({
  runId,
  kind,
  terminal: false,
  closed: false,
  ...(action ? { action } : {}),
});

/** The run that id-less events belong to: the one whose stream is still open. */
export const openRunId = (state: ThreadState): string | null =>
  state.invocation && !state.invocation.closed ? state.invocation.runId : null;

export const isInvocationActive = (state: ThreadState): boolean =>
  !!state.invocation && !state.invocation.terminal && !state.invocation.closed;

/** The thread's latest run: the only one that takes Retry step or an edit. */
export const latestRunId = (state: ThreadState): string | null => state.runIds[state.runIds.length - 1] ?? null;

/**
 * The run Stop applies to: the one whose stream is open, else the latest run while it is still
 * planning, executing or answering (a stream lost or restored, followed through the view route).
 */
export const activeRunId = (state: ThreadState): string | null => {
  if (isInvocationActive(state) && state.invocation) return state.invocation.runId;
  const latest = latestRunId(state);
  const run = latest ? state.runs[latest] : undefined;
  return run && !run.stopRequested && (run.status === 'Planning' || run.status === 'Executing' || run.status === 'Answering')
    ? run.runId
    : null;
};

const withOpenRun = (
  state: ThreadState,
  update: (run: RunState) => RunState,
): ThreadState => {
  const runId = openRunId(state);
  const run = runId ? state.runs[runId] : undefined;
  return run ? putRun(state, update(run)) : flagThread(state, 'ORPHAN_EVENT');
};

const STEP_PENDING: ReadonlySet<StepStatus> = new Set(['Queued', 'AwaitingUser']);

/**
 * STEP_STARTED moves a waiting step to Running. STEP_FINISHED changes nothing: the
 * agent sends it before the snapshot that says whether the step was Done, Empty or
 * Failed, and a run can fail before that snapshot arrives.
 */
const applyStepEvent = (
  run: RunState,
  stepId: string,
  event: 'STEP_STARTED' | 'STEP_FINISHED',
): RunState => {
  const step = run.view?.steps.find((s) => s.id === stepId);
  if (!run.view || !step) return { ...run, flags: addFlag(run.flags, 'UNKNOWN_STEP') };
  if (event === 'STEP_FINISHED' || !STEP_PENDING.has(step.status)) return run;
  const steps = run.view.steps.map((s): Step => (s.id === stepId ? { ...s, status: 'Running' } : s));
  return { ...run, view: { ...run.view, steps } };
};

const snapshotStatus = (run: RunState, view: RunView): RunStatus =>
  run.stopRequested && !isEndStatus(view.status) ? 'Stopping' : view.status;

/**
 * Files the snapshot under its own run, which need not be the invocation's: a turn reports an
 * earlier run of the thread that it found Interrupted in the same stream.
 */
const applySnapshot = (state: ThreadState, view: RunView, fromRoute = false): ThreadState => {
  if (view.threadId !== state.threadId) return flagThread(state, 'FOREIGN_THREAD');
  const run = state.runs[view.runId] ?? createRun(view.runId, view.question);
  if (run.view && view.revision <= run.view.revision) return state;
  const ended =
    !fromRoute && state.invocation?.runId === view.runId && state.invocation.terminal;
  // A stop the view shows done (or the run already over) needs no Stopping any more.
  const stopRequested = run.stopRequested && !isEndStatus(view.status);
  return putRun(state, {
    ...run,
    question: run.question || view.question,
    view,
    started: run.started || fromRoute,
    stopRequested,
    // A view that shows the run settled answers the lost stream.
    transportError: fromRoute && !isLeasedStatus(view.status) ? null : run.transportError,
    // Within one invocation the terminal event has the last word on status.
    ...(ended ? {} : { status: snapshotStatus(run, view), code: view.code }),
  });
};

const endInvocation = (state: ThreadState): ThreadState =>
  state.invocation ? { ...state, invocation: { ...state.invocation, terminal: true } } : state;

/**
 * A rejection never shows as a Failed run. A rejected ask takes back the run the browser
 * showed for it; a rejected Stop leaves its run with the last status a snapshot reported.
 * A Stop answered RUN_NOT_FOUND before any snapshot also takes its run back: the ask was
 * aborted before the agent launched it, so the run only ever existed in this browser.
 */
const rejectTurn = (
  state: ThreadState,
  run: RunState,
  code: NoticeCode,
  message: string,
): ThreadState => {
  const invocation = state.invocation?.runId === run.runId ? state.invocation : null;
  const turn = invocation?.kind ?? 'other';
  const takeBack = turn === 'ask' || (turn === 'cancel' && code === 'RUN_NOT_FOUND' && !run.view);
  const notice: ThreadNotice = {
    code,
    message,
    turn,
    question: takeBack ? run.question : null,
    ...(invocation?.action ? { action: invocation.action } : {}),
  };
  const ended: ThreadState = { ...endInvocation(state), notice };
  if (takeBack) return dropRun(ended, run.runId);
  if (turn === 'cancel') {
    return putRun(ended, { ...run, stopRequested: false, status: run.view?.status ?? 'Planning' });
  }
  return ended;
};

const updateMessage = (
  run: RunState,
  id: string,
  update: (message: TextMessageState) => TextMessageState,
): RunState => ({
  ...run,
  messages: run.messages.map((m) => (m.id === id ? update(m) : m)),
});

const updateToolCall = (
  run: RunState,
  id: string,
  update: (call: ToolCallState) => ToolCallState,
): RunState => ({
  ...run,
  toolCalls: run.toolCalls.map((c) => (c.id === id ? update(c) : c)),
});

export const threadReducer = (state: ThreadState, action: ThreadAction): ThreadState => {
  switch (action.type) {
    case 'submit': {
      if (state.runs[action.runId]) return state;
      const run = createRun(action.runId, action.question, action.at);
      return { ...putRun(state, run), invocation: openInvocation(run.runId, 'ask', 'ask'), notice: null };
    }
    case 'stop': {
      const run = state.runs[action.runId];
      if (!run || isEndStatus(run.status)) return state;
      // Stop is its own turn (`cancel`), so it opens a new invocation.
      return {
        ...putRun(state, { ...run, stopRequested: true, status: 'Stopping' }),
        invocation: openInvocation(run.runId, 'cancel', 'cancel'),
        notice: null,
      };
    }
    case 'turn': {
      const run = state.runs[action.runId];
      if (!run) return state;
      const current = state.invocation;
      // The click already opened this invocation (submit, stop): the turn leaving keeps it.
      if (current?.runId === action.runId && current.kind === action.kind && !current.terminal && !current.closed) {
        return current.action === action.action
          ? state
          : { ...state, invocation: { ...current, action: action.action } };
      }
      return {
        ...state,
        runs: run.transportError ? { ...state.runs, [run.runId]: { ...run, transportError: null } } : state.runs,
        invocation: openInvocation(action.runId, action.kind, action.action),
        notice: null,
      };
    }
    case 'withdraw': {
      const run = state.runs[action.runId];
      const invocation = state.invocation;
      if (!run || !invocation || invocation.runId !== action.runId) return state;
      if (!isInvocationActive(state)) return state;
      return {
        ...putRun(state, { ...run, stopRequested: true, status: 'Cancelled' }),
        invocation: { ...invocation, closed: true },
      };
    }
    case 'transportError': {
      const run = state.runs[action.runId];
      const invocation = state.invocation;
      if (!run || !invocation || invocation.runId !== action.runId) return state;
      if (invocation.terminal) return state;
      // A closed stream takes a second report only when checking the view route failed too.
      if (invocation.closed && run.transportError === null) return state;
      const failure = { code: action.code, message: action.message };
      return {
        ...putRun(state, {
          ...run,
          transportError: failure,
          ...(run.started || action.checking ? {} : { status: 'Failed' as const, errorMessage: action.message }),
        }),
        invocation: { ...invocation, closed: true },
      };
    }
    case 'protocolError': {
      const run = state.runs[action.runId];
      return run
        ? putRun(state, { ...run, protocolErrors: [...run.protocolErrors, action.error] })
        : state;
    }
    case 'view':
      return applySnapshot(state, action.view, true);
    case 'turnRejected': {
      const run = state.runs[action.runId];
      return run ? rejectTurn(state, run, action.code, action.message) : state;
    }
    case 'turnSettled':
      return state.invocation?.runId === action.runId && !state.invocation.terminal
        ? endInvocation(state)
        : state;
    case 'dropRun': {
      const run = state.runs[action.runId];
      if (!run) return state;
      const dropped = dropRun(state, action.runId);
      const invocation = dropped.invocation?.runId === action.runId ? null : dropped.invocation;
      // A question that never reached a run goes back to the composer, as a rejected ask does.
      const notice: ThreadNotice | null = run.view
        ? dropped.notice
        : { code: 'RUN_NOT_FOUND', message: 'The run is not stored', turn: 'ask', question: run.question };
      return { ...dropped, invocation, notice };
    }
    case 'RUN_STARTED': {
      if (action.threadId !== state.threadId) return flagThread(state, 'FOREIGN_THREAD');
      const run = state.runs[action.runId] ?? createRun(action.runId);
      const current = state.invocation;
      const continues =
        current?.runId === action.runId && !current.terminal && !current.closed;
      return {
        ...putRun(state, { ...run, started: true }),
        invocation: continues ? current : openInvocation(action.runId, 'other'),
      };
    }
    case 'STATE_SNAPSHOT':
      return applySnapshot(state, action.snapshot);
    case 'STEP_STARTED':
    case 'STEP_FINISHED':
      return withOpenRun(state, (run) => applyStepEvent(run, action.stepName, action.type));
    case 'CUSTOM':
      if (action.name !== 'orion.heartbeat') return state;
      return withOpenRun(state, (run) => ({ ...run, lastHeartbeatAt: action.value.ts }));
    case 'TOOL_CALL_START':
      return withOpenRun(state, (run) => ({
        ...run,
        toolCalls: [
          ...run.toolCalls.filter((c) => c.id !== action.toolCallId),
          { id: action.toolCallId, name: action.toolCallName, args: '', ended: false },
        ],
      }));
    case 'TOOL_CALL_ARGS':
      return withOpenRun(state, (run) =>
        updateToolCall(run, action.toolCallId, (c) => ({ ...c, args: c.args + action.delta })),
      );
    case 'TOOL_CALL_END':
      return withOpenRun(state, (run) =>
        updateToolCall(run, action.toolCallId, (c) => ({ ...c, ended: true })),
      );
    case 'TEXT_MESSAGE_START':
      return withOpenRun(state, (run) => ({
        ...run,
        messages: [...run.messages.filter((m) => m.id !== action.messageId), { id: action.messageId, text: '', ended: false }],
      }));
    case 'TEXT_MESSAGE_CONTENT':
      return withOpenRun(state, (run) =>
        updateMessage(run, action.messageId, (m) => ({ ...m, text: m.text + action.delta })),
      );
    case 'TEXT_MESSAGE_END':
      return withOpenRun(state, (run) =>
        updateMessage(run, action.messageId, (m) => ({ ...m, ended: true })),
      );
    case 'RUN_FINISHED': {
      const run = state.runs[action.runId];
      const inThisInvocation = state.invocation?.runId === action.runId;
      if (inThisInvocation && state.invocation?.terminal) {
        return run
          ? putRun(state, { ...run, flags: addFlag(run.flags, 'DOUBLE_TERMINAL') })
          : state;
      }
      const ended = inThisInvocation ? endInvocation(state) : state;
      const { status, code } = action.result;
      // Warmed and Recorded answer turns that carry no run status (warmup, a standalone viz_report).
      if (status === 'Warmed' || status === 'Recorded') return ended;
      if (!run) return flagThread(ended, 'UNKNOWN_RUN');
      return putRun(ended, {
        ...run,
        status,
        code,
        stopRequested: run.stopRequested && !isEndStatus(status),
        transportError: null,
      });
    }
    case 'RUN_ERROR': {
      const runId = openRunId(state);
      const run = runId ? state.runs[runId] : undefined;
      if (!run) return flagThread(state, 'ORPHAN_EVENT');
      if (state.invocation?.terminal) {
        return putRun(state, { ...run, flags: addFlag(run.flags, 'DOUBLE_TERMINAL') });
      }
      if (isRejectionCode(action.code)) {
        return rejectTurn(state, run, action.code, action.message);
      }
      return putRun(endInvocation(state), {
        ...run,
        status: 'Failed',
        code: action.code,
        errorMessage: action.message,
      });
    }
    default:
      return state;
  }
};
