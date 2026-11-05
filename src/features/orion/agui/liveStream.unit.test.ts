import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { createElement } from 'react';
import { screen, within } from '@testing-library/react';
import { ThreadView } from '../components/ThreadView';
import { noticeText } from '../notices';
import { threadRuns } from '../state/tab';
import { renderWithMantine } from '../testing';
import {
  createThread,
  isRejectionCode,
  threadReducer,
  type InvocationKind,
  type RunState,
  type ThreadNotice,
  type ThreadState,
} from './reducer';
import { createSseParser, type SseParseError } from './sseParser';
import type {
  AguiEvent,
  OrionActionName,
  RunErrorEvent,
  RunFinishedEvent,
  RunStartedEvent,
  RunStatus,
  RunView,
} from './types';

/**
 * Replays streams captured from a running agent (orion/agent/.dev/*.sse in the sandbox
 * repo) through the parser, the reducer and the thread view, and checks each against the
 * contract's outcome. Opt in with ORION_LIVE_SSE_DIR=<dir>.
 */
const LIVE_DIR = process.env.ORION_LIVE_SSE_DIR;
const CAPTURES = LIVE_DIR
  ? readdirSync(LIVE_DIR)
      .filter((name) => name.endsWith('.sse'))
      .sort()
  : [];

/** Stands in for the ids the browser chose when the stream echoes none back. */
const BROWSER_ID = '0'.repeat(32);
/** The question the browser shows for its own ask until a snapshot names it. */
const QUESTION = 'Question asked in this browser';

const RESERVED_ACTIONS: readonly OrionActionName[] = [
  'clarify_answer',
  'consent',
  'confirm',
  'edit_plan',
  'retry_step',
  'viz_report',
];

/**
 * The browser turn behind a capture, from its file name: `cancel-*` is a Stop on a run the
 * thread shows, a reserved action such as `confirm-*` has no browser turn yet, and every
 * other capture is an ask.
 */
const turnOf = (name: string): InvocationKind => {
  if (name.startsWith('cancel-')) return 'cancel';
  return RESERVED_ACTIONS.some((action) => name.startsWith(`${action}-`)) ? 'other' : 'ask';
};

type TerminalEvent = RunFinishedEvent | RunErrorEvent;

const isTerminal = (event: AguiEvent): event is TerminalEvent =>
  event.type === 'RUN_FINISHED' || event.type === 'RUN_ERROR';

const isRunStarted = (event: AguiEvent): event is RunStartedEvent => event.type === 'RUN_STARTED';

const snapshotsOf = (events: AguiEvent[]): RunView[] =>
  events.flatMap((e) => (e.type === 'STATE_SNAPSHOT' ? [e.snapshot] : []));

// RUN_STARTED cannot echo ids that break the id format, so the agent answers malformed ids
// with this lone frame, and the reducer files it under the run the browser submitted.
const isIdRejection = (events: AguiEvent[]): boolean =>
  events.length === 1 && events[0].type === 'RUN_ERROR' && events[0].code === 'INVALID_INPUT';

const parseCapture = (bytes: Uint8Array): { events: AguiEvent[]; errors: SseParseError[] } => {
  const events: AguiEvent[] = [];
  const errors: SseParseError[] = [];
  for (const item of createSseParser().push(bytes)) {
    if (item.kind === 'event') events.push(item.event);
    else errors.push(item.error);
  }
  return { events, errors };
};

interface Replay {
  state: ThreadState;
  runId: string;
  /** The target run's status on screen before the turn; undefined when the thread had none. */
  statusBefore: RunStatus | undefined;
}

/** The browser opens the turn (submit, or Stop after its own ask) before its stream arrives. */
const replay = (events: AguiEvent[], turn: InvocationKind): Replay => {
  const started = events.find(isRunStarted);
  const threadId = started?.threadId ?? BROWSER_ID;
  const runId = started?.runId ?? BROWSER_ID;
  const thread = createThread(threadId);
  const asked =
    turn === 'other'
      ? thread
      : threadReducer(thread, { type: 'submit', runId, question: QUESTION, at: '2026-11-04T00:00:00.000Z' });
  const opened = turn === 'cancel' ? threadReducer(asked, { type: 'stop', runId }) : asked;
  return {
    state: events.reduce(threadReducer, opened),
    runId,
    statusBefore: asked.runs[runId]?.status,
  };
};

const renderThread = (state: ThreadState): HTMLElement[] => {
  renderWithMantine(
    createElement(ThreadView, {
      runs: threadRuns(state),
      running: false,
      onStop: jest.fn(),
      onOpenApp: jest.fn(),
      notice: state.notice,
    }),
  );
  return screen.queryAllByRole('article');
};

/** What the contract says each run's item shows once its stream has ended. */
const expectRunItem = (article: HTMLElement, run: RunState): void => {
  const item = within(article);
  const scope = run.view?.plan?.scope;
  if (scope) {
    if (scope.caseCount === null) {
      expect(item.getByText(`Scope: ${scope.name} · count pending`)).toBeInTheDocument();
    } else {
      expect(item.getByText((text) => text.startsWith(`Scope: ${scope.name} · `))).toBeInTheDocument();
      expect(item.queryByText(/count pending/)).toBeNull();
    }
  }
  if (run.status !== 'Failed') expect(item.queryByText('This run failed')).toBeNull();
  if (run.status === 'Interrupted') {
    expect(item.getAllByText('Interrupted').length).toBeGreaterThan(0);
    expect(item.getByText(/ORION lost this run before it finished/)).toBeInTheDocument();
  }
  if (run.status === 'Unsupported') {
    const nearest = run.view?.limitations.flatMap((l) => l.nearestApps)[0];
    if (nearest) {
      expect(item.getByText(nearest.title)).toBeInTheDocument();
      expect(item.getByRole('button', { name: 'Open on this cohort' })).toBeInTheDocument();
    } else {
      expect(item.queryByText(/Nearest app/)).toBeNull();
    }
  }
};

const describeLive = LIVE_DIR ? describe : describe.skip;

describeLive('live agent streams', () => {
  it('finds .sse captures to replay', () => {
    expect(CAPTURES.length).toBeGreaterThan(0);
  });

  for (const name of CAPTURES) {
    it(`replays ${name}`, () => {
      const bytes = new Uint8Array(readFileSync(path.join(LIVE_DIR ?? '', name)));
      // A frame without its blank line stays buffered, so a truncated capture would lose it silently.
      expect(new TextDecoder().decode(bytes).endsWith('\n\n')).toBe(true);

      const { events, errors } = parseCapture(bytes);
      expect(errors).toEqual([]);
      expect(events.length).toBeGreaterThan(0);
      if (!isIdRejection(events)) expect(events[0].type).toBe('RUN_STARTED');

      const terminals = events.filter(isTerminal);
      expect(terminals).toHaveLength(1);
      const terminal = terminals[0];
      expect(events[events.length - 1]).toBe(terminal);

      const turn = turnOf(name);
      const { state, runId, statusBefore } = replay(events, turn);
      const snapshots = snapshotsOf(events);
      const ownSnapshots = snapshots.filter((view) => view.runId === runId);
      const revisions = ownSnapshots.map((view) => view.revision);
      expect(revisions.filter((revision, i) => i > 0 && revision <= revisions[i - 1])).toEqual([]);
      for (const view of snapshots) {
        expect(view.limitations.filter((l) => !Array.isArray(l.nearestApps))).toEqual([]);
        // Design eval E18: no analysis draws a Venn diagram; Set Operations is the nearest app.
        if (/venn/i.test(view.question) && view.status === 'Unsupported') {
          expect(view.limitations[0].nearestApps[0]).toEqual({
            appId: 'SetOperations',
            title: 'Set Operations',
          });
        }
      }

      expect(state.flags).toEqual([]);
      expect(state.invocation).toEqual({ runId, kind: turn, terminal: true, closed: false });
      if (terminal.type === 'RUN_ERROR' && isRejectionCode(terminal.code)) {
        // A rejected turn created no run and changed none: nothing shows Failed, and a notice says why.
        expect(events.map((e) => e.type)).toEqual(
          isIdRejection(events) ? ['RUN_ERROR'] : ['RUN_STARTED', 'RUN_ERROR'],
        );
        // The replayed Stop comes before any snapshot, so RUN_NOT_FOUND means the agent never
        // had the run, and the browser takes it back as it does a rejected ask.
        const tookBack = turn === 'ask' || (turn === 'cancel' && terminal.code === 'RUN_NOT_FOUND');
        const notice: ThreadNotice = {
          code: terminal.code,
          message: terminal.message,
          turn,
          question: tookBack ? QUESTION : null,
        };
        expect(state.notice).toEqual(notice);
        expect(threadRuns(state).filter((run) => run.status === 'Failed')).toEqual([]);
        if (tookBack) {
          expect(state.runs[runId]).toBeUndefined();
        } else if (turn === 'cancel') {
          expect(state.runs[runId]).toMatchObject({ status: statusBefore, stopRequested: false });
        }
        renderThread(state);
        expect(screen.getByRole('note')).toHaveTextContent(noticeText(notice));
        expect(screen.queryByText('This run failed')).toBeNull();
        return;
      }
      expect(state.notice).toBeNull();
      const run = state.runs[runId];
      expect(run.flags).toEqual([]);
      if (revisions.length > 0) expect(run.view?.revision).toBe(Math.max(...revisions));

      // An earlier run this turn found with an expired lease is reported right after
      // RUN_STARTED, and the browser files it under its own run as Interrupted.
      const reported = snapshots.filter((view) => view.runId !== runId);
      expect(reported.map((view) => view.status)).toEqual(reported.map(() => 'Interrupted'));
      if (reported.length > 0) {
        expect(events.findIndex((e) => e.type === 'STATE_SNAPSHOT' && e.snapshot.runId !== runId)).toBe(1);
      }
      for (const view of reported) {
        expect(state.runs[view.runId]).toMatchObject({ status: 'Interrupted', code: 'RUN_INTERRUPTED' });
      }

      if (terminal.type === 'RUN_ERROR') {
        expect(run).toMatchObject({
          status: 'Failed',
          code: terminal.code,
          errorMessage: terminal.message,
        });
        return;
      }
      if (terminal.result.status === 'Warmed') {
        expect(ownSnapshots).toEqual([]);
        return;
      }
      expect({ status: run.status, code: run.code }).toEqual(terminal.result);
      const last = ownSnapshots[ownSnapshots.length - 1];
      if (last) expect({ status: last.status, code: last.code }).toEqual(terminal.result);
      if (terminal.result.status === 'Interrupted') {
        // A turn that targeted a lost run shows its Interrupted snapshot first, then ends with it.
        expect(events[1]).toMatchObject({ type: 'STATE_SNAPSHOT', snapshot: { runId, status: 'Interrupted' } });
      }

      const runs = threadRuns(state);
      const articles = renderThread(state);
      expect(articles).toHaveLength(runs.length);
      runs.forEach((item, i) => expectRunItem(articles[i], item));
    });
  }
});
