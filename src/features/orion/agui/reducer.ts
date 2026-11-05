import type { SseParseError } from './sseParser';
import {
  END_STATUSES,
  REJECTION_CODES,
  type AguiEvent,
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

/** What opened an invocation: a question, a Stop, or a stream the browser did not start here. */
export type InvocationKind = 'ask' | 'cancel' | 'other';

/** One POST and its stream. Exactly one terminal event ends it. */
export interface Invocation {
  runId: string;
  kind: InvocationKind;
  terminal: boolean;
  closed: boolean;
}

/** A turn the server rejected. It created no run and changed none. */
export interface ThreadNotice {
  code: RejectionCode;
  message: string;
  turn: InvocationKind;
  /** The question of the run the rejection took back, for the composer; null if none was. */
  question: string | null;
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
  /** Stop before the ask left the browser: no turn reached the server, so none reports the end. */
  | { type: 'withdraw'; runId: string }
  | { type: 'transportError'; runId: string; code: string; message: string }
  | { type: 'protocolError'; runId: string; error: SseParseError };

export type ThreadAction = AguiEvent | LocalAction;

const END: ReadonlySet<RunStatus> = new Set(END_STATUSES);
export const isEndStatus = (status: RunStatus): boolean => END.has(status);

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

const openInvocation = (runId: string, kind: InvocationKind): Invocation => ({
  runId,
  kind,
  terminal: false,
  closed: false,
});

/** The run that id-less events belong to: the one whose stream is still open. */
export const openRunId = (state: ThreadState): string | null =>
  state.invocation && !state.invocation.closed ? state.invocation.runId : null;

export const isInvocationActive = (state: ThreadState): boolean =>
  !!state.invocation && !state.invocation.terminal && !state.invocation.closed;

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
const applySnapshot = (state: ThreadState, view: RunView): ThreadState => {
  if (view.threadId !== state.threadId) return flagThread(state, 'FOREIGN_THREAD');
  const run = state.runs[view.runId] ?? createRun(view.runId, view.question);
  if (run.view && view.revision <= run.view.revision) return state;
  const ended =
    state.invocation?.runId === view.runId && state.invocation.terminal;
  return putRun(state, {
    ...run,
    question: run.question || view.question,
    view,
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
const rejectInvocation = (
  state: ThreadState,
  run: RunState,
  code: RejectionCode,
  message: string,
): ThreadState => {
  const turn = state.invocation?.kind ?? 'other';
  const takeBack =
    turn === 'ask' || (turn === 'cancel' && code === 'RUN_NOT_FOUND' && !run.view);
  const ended: ThreadState = {
    ...endInvocation(state),
    notice: { code, message, turn, question: takeBack ? run.question : null },
  };
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
      return { ...putRun(state, run), invocation: openInvocation(run.runId, 'ask'), notice: null };
    }
    case 'stop': {
      const run = state.runs[action.runId];
      if (!run || isEndStatus(run.status)) return state;
      // Stop is its own turn (`cancel`), so it opens a new invocation.
      return {
        ...putRun(state, { ...run, stopRequested: true, status: 'Stopping' }),
        invocation: openInvocation(run.runId, 'cancel'),
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
      if (invocation.terminal || invocation.closed) return state;
      const failure = { code: action.code, message: action.message };
      return {
        ...putRun(state, {
          ...run,
          transportError: failure,
          ...(run.started ? {} : { status: 'Failed' as const, errorMessage: action.message }),
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
          ...run.toolCalls,
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
        messages: [...run.messages, { id: action.messageId, text: '', ended: false }],
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
      return putRun(ended, { ...run, status, code });
    }
    case 'RUN_ERROR': {
      const runId = openRunId(state);
      const run = runId ? state.runs[runId] : undefined;
      if (!run) return flagThread(state, 'ORPHAN_EVENT');
      if (state.invocation?.terminal) {
        return putRun(state, { ...run, flags: addFlag(run.flags, 'DOUBLE_TERMINAL') });
      }
      if (isRejectionCode(action.code)) {
        return rejectInvocation(state, run, action.code, action.message);
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
