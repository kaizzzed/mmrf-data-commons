import React, { type ReactElement, type ReactNode } from 'react';
import { readFileSync } from 'fs';
import path from 'path';
import { MantineProvider } from '@mantine/core';
import { render, type RenderResult } from '@testing-library/react';
import { cohortReducer, removeCohort, setCohortList, setCurrentCohortId, type Cohort, type CoreState } from '@gen3/core';
import { COHORT_FILTER_INDEX } from '@/core/constants';
import { createThread, threadReducer, type RunState, type ThreadState } from './agui/reducer';
import { createSseParser } from './agui/sseParser';
import {
  ORION_ROUTES,
  SSE_RESPONSE_HEADERS,
  type AguiEvent,
  type BffErrorCode,
  type OrionActionName,
  type RunAgentInput,
  type RunRecord,
  type RunView,
  type WireFilterSet,
} from './agui/types';
import { storeCohortPort, type CohortPort } from './cohort/cohortPort';
import { RunActionsContext, INERT_ACTIONS, type RunActions } from './components/RunActions';
import type { Notifier } from './handoff/notifier';
import { BFF_ERROR_STATUS } from './server/routes';

/** Test-only helpers; nothing in the app imports this module. */

export const FIXTURE_DIR = path.join(__dirname, 'agui', '__fixtures__');
export const FIXTURE_PATH = path.join(FIXTURE_DIR, 'j1-stub.events.jsonl');

export const readFixtureBytes = (): Uint8Array => new Uint8Array(readFileSync(FIXTURE_PATH));

export const fixtureEvents = (): AguiEvent[] => streamEvents('j1-stub');

/** The eighteen recorded streams of the contract (agui/__fixtures__). */
export const STREAM_NAMES = [
  'j1-stub',
  'j1-complete',
  'j1-partial',
  'j1-retry',
  'j1-stop',
  'j2-save-pause',
  'j2-after-confirm',
  'j2-dont-save',
  'j3-save-pause',
  'j3-after-confirm',
  'j3-edit-at-pause',
  'j3-dont-save',
  'j3-deinput',
  'oncomatrix',
  'clarify',
  'consent',
  'interrupted',
  'cancel-waiting',
] as const;
export type StreamName = (typeof STREAM_NAMES)[number];

/** Streams that continue a run another fixture left paused or ended. */
export const PREDECESSOR: Partial<Record<StreamName, StreamName>> = {
  'j2-after-confirm': 'j2-save-pause',
  'j3-after-confirm': 'j3-save-pause',
  'j1-retry': 'j1-partial',
};

export const streamText = (name: StreamName): string =>
  readFileSync(path.join(FIXTURE_DIR, `${name}.events.jsonl`), 'utf8');

export const streamEvents = (name: StreamName): AguiEvent[] =>
  createSseParser()
    .push(new Uint8Array(readFileSync(path.join(FIXTURE_DIR, `${name}.events.jsonl`))))
    .map((item) => {
      if (item.kind !== 'event') throw new Error(`${name}: ${item.error.message}`);
      return item.event;
    });

export const streamViews = (name: StreamName): RunView[] =>
  streamEvents(name).flatMap((e) => (e.type === 'STATE_SNAPSHOT' ? [e.snapshot] : []));

/** The run the stream's RUN_STARTED names: the invocation's own run. */
export const streamRunId = (name: StreamName): string => {
  const [first] = streamEvents(name);
  if (first.type !== 'RUN_STARTED') throw new Error(`${name} does not start with RUN_STARTED`);
  return first.runId;
};

/** Replays a stream (after the one it continues) through the reducer, as the browser would. */
export const replayStream = (name: StreamName, state?: ThreadState): ThreadState => {
  const before = PREDECESSOR[name];
  const start = state ?? (before ? replayStream(before) : createThread(streamViews(name)[0].threadId));
  return streamEvents(name).reduce(threadReducer, start);
};

/** The invocation's run after its stream, as the reducer leaves it. */
export const replayedRun = (name: StreamName): RunState => replayStream(name).runs[streamRunId(name)];

export const readRecord = (name: 'run-record.j1-complete.json' | 'run-record.j1-retry.json'): RunRecord =>
  JSON.parse(readFileSync(path.join(FIXTURE_DIR, name), 'utf8')) as RunRecord;

export const renderWithMantine = (ui: ReactElement): RenderResult =>
  render(<MantineProvider>{ui}</MantineProvider>);

/** Every action a jest.fn, with any given overrides. */
export const mockActions = (overrides: Partial<RunActions> = {}): RunActions => ({
  ...INERT_ACTIONS,
  threadId: 'f'.repeat(32),
  composerHasText: jest.fn(() => false),
  askFollowUp: jest.fn(),
  clarify: jest.fn(),
  cancel: jest.fn(),
  consent: jest.fn(),
  create: jest.fn(),
  dontSave: jest.fn(),
  edit: jest.fn(),
  retry: jest.fn(),
  inspect: jest.fn(),
  openOnCohort: jest.fn(),
  openInTool: jest.fn(),
  openLink: jest.fn(),
  reportViz: jest.fn(),
  loadUntrimmedSpec: jest.fn(() => Promise.resolve(null)),
  ...overrides,
});

export const renderWithActions = (ui: ReactElement, actions: RunActions): RenderResult =>
  renderWithMantine(<RunActionsContext.Provider value={actions}>{ui}</RunActionsContext.Provider>);

export const ActionsProvider = ({ actions, children }: { actions: RunActions; children: ReactNode }) => (
  <RunActionsContext.Provider value={actions}>{children}</RunActionsContext.Provider>
);

// ------------------------------------------------------------------ a mocked @gen3/core store

export interface TestCohort {
  id: string;
  name: string;
  /** The case_centric FilterSet; omitted means none (all cases). */
  filters?: WireFilterSet;
  caseCount?: number;
}

export interface TestCohortStore {
  port: CohortPort;
  state(): CoreState;
  /** Every action the port dispatched that was a thunk (the platform's count queries). */
  thunks: unknown[];
  /** Cohort ids the port asked the platform to count. */
  refreshed: string[];
  /** Makes the next `create` do nothing, as a store that refuses the cohort would. */
  failNextCreate(): void;
  /** Deletes a cohort, as the researcher would from the cohort bar. */
  remove(id: string): void;
}

const cohortOf = (c: TestCohort, at: string): Cohort => ({
  id: c.id,
  name: c.name,
  filters: c.filters ? { [COHORT_FILTER_INDEX]: c.filters as unknown as Cohort['filters'][string] } : {},
  createdDatetime: at,
  modifiedDatetime: at,
  counts: c.caseCount === undefined ? {} : { [COHORT_FILTER_INDEX]: c.caseCount },
});

/**
 * The platform's own cohort reducer behind the port, so createNewCohort's real behaviour (no id
 * returned, clashing names renamed) is what the adapter meets.
 */
export const createTestCohortStore = (cohorts: TestCohort[], currentId: string | null = cohorts[0]?.id ?? null): TestCohortStore => {
  let manager = cohortReducer(undefined, { type: '@@orion/init' });
  manager = cohortReducer(manager, setCohortList(null as unknown as Cohort[]));
  manager = cohortReducer(
    manager,
    setCohortList(cohorts.map((c, i) => cohortOf(c, new Date(Date.UTC(2026, 10, 1, 0, 0, i)).toISOString()))),
  );
  if (currentId) manager = cohortReducer(manager, setCurrentCohortId(currentId));
  const thunks: unknown[] = [];
  const refreshed: string[] = [];
  let failCreate = false;
  const state = () => ({ cohorts: { cohortManager: manager } }) as unknown as CoreState;
  const store = {
    getState: state,
    dispatch: (action: unknown) => {
      if (typeof action === 'function') {
        thunks.push(action);
        return { unwrap: () => Promise.resolve(0), unsubscribe: () => undefined };
      }
      const typed = action as { type: string };
      if (typed.type === 'cohort/createNewCohort' && failCreate) {
        failCreate = false;
        return action;
      }
      manager = cohortReducer(manager, typed as Parameters<typeof cohortReducer>[1]);
      return action;
    },
  };
  const inner = storeCohortPort(store);
  return {
    port: {
      ...inner,
      refreshCount: (id) => {
        refreshed.push(id);
        inner.refreshCount(id);
      },
    },
    state,
    thunks,
    refreshed,
    failNextCreate: () => {
      failCreate = true;
    },
    remove: (id) => {
      manager = cohortReducer(manager, removeCohort({ id }));
    },
  };
};

export interface RecordingNotifier extends Notifier {
  undos: { message: string; onUndo: () => boolean }[];
  errors: string[];
}

export const recordingNotifier = (): RecordingNotifier => {
  const undos: RecordingNotifier['undos'] = [];
  const errors: string[] = [];
  return {
    undos,
    errors,
    undo: (message, onUndo) => {
      undos.push({ message, onUndo });
    },
    error: (message) => {
      errors.push(message);
    },
  };
};

// ------------------------------------------------------------------ a fake BFF behind the real transport

/** How the fake BFF answers one turn. */
export type FakeReply =
  /**
   * Recorded SSE bytes, relayed unchanged in uneven chunks (frames and UTF-8 sequences cut). With
   * `hold`, the first `hold.frames` frames go at once and the rest once `hold.release` resolves.
   */
  | { stream: string; hold?: { frames: number; release: Promise<void> } }
  /** These bytes, then nothing more until the browser aborts the request (a run still going). */
  | { hang: string }
  /** A BffError JSON body with the contract's status for the code. */
  | { error: BffErrorCode; message?: string };

export interface FakeBff {
  /** The `fetch` the real httpTransport and httpRoutes are given. */
  fetch: typeof fetch;
  /** Every turn, parsed, in the order the browser sent them. */
  turns: RunAgentInput[];
  /** Every GET, as path and query. */
  gets: string[];
  /** Queues replies for the next turns with this action (each is used once). */
  reply(action: OrionActionName, ...replies: FakeReply[]): void;
  /** The view route's runs. A relayed stream stores each run's last snapshot, as the agent's record would. */
  views: Map<string, RunView>;
  /** Views the route serves in place of a stream's (the record's untrimmed runView). */
  untrimmed: Map<string, RunView>;
  /** The record route's records. */
  records: Map<string, RunRecord>;
  /** Turns no reply was queued for (each got RUN_ERROR NOT_IMPLEMENTED): a test expects none. */
  unexpected: RunAgentInput[];
}

const CHUNK_SIZES = [1, 7, 4096, 13, 977];
const encoder = new TextEncoder();

const enqueueChunked = (controller: ReadableStreamDefaultController<Uint8Array>, text: string): void => {
  const bytes = encoder.encode(text);
  let offset = 0;
  for (let i = 0; offset < bytes.length; i++) {
    const size = CHUNK_SIZES[i % CHUNK_SIZES.length];
    controller.enqueue(bytes.subarray(offset, offset + size));
    offset += size;
  }
};

/** The bytes of `first`, then (once `release` resolves) of `rest`; open forever when `rest` is null. */
const chunked = (first: string, rest: { text: string; release: Promise<void> } | null, hang: boolean): ReadableStream<Uint8Array> => {
  let cancelled = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      enqueueChunked(controller, first);
      if (rest) {
        void rest.release.then(() => {
          if (cancelled) return;
          enqueueChunked(controller, rest.text);
          controller.close();
        });
      } else if (!hang) {
        controller.close();
      }
    },
    cancel() {
      cancelled = true;
    },
  });
};

const sseOf = (events: AguiEvent[]): string => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });

const RUN_PATH = /^\/api\/orion\/runs\/([0-9a-f]{32})\/(view|record)$/;

/**
 * The three BFF routes as the browser meets them (contract "BFF routes"), over `fetch`: the agui
 * route relays the reply queued for the turn's action, a warm-up answers Warmed and a standalone
 * viz_report Recorded; the view and record routes serve their maps, 404 RUN_NOT_FOUND otherwise
 * (or when `threadId` names another thread).
 */
export const createFakeBff = (): FakeBff => {
  const turns: RunAgentInput[] = [];
  const gets: string[] = [];
  const queued = new Map<OrionActionName, FakeReply[]>();
  const views = new Map<string, RunView>();
  const untrimmed = new Map<string, RunView>();
  const records = new Map<string, RunRecord>();
  const unexpected: RunAgentInput[] = [];

  const keepViews = (text: string) => {
    for (const item of createSseParser().push(encoder.encode(text))) {
      if (item.kind === 'event' && item.event.type === 'STATE_SNAPSHOT') views.set(item.event.snapshot.runId, item.event.snapshot);
    }
  };

  const stream = (text: string, hang = false, hold?: { frames: number; release: Promise<void> }): Response => {
    keepViews(text);
    const body = hold
      ? chunked(streamPrefix(text, hold.frames), { text: text.split('\n\n').slice(hold.frames).join('\n\n'), release: hold.release }, false)
      : chunked(text, null, hang);
    return new Response(body, { status: 200, headers: SSE_RESPONSE_HEADERS });
  };

  const turn = (input: RunAgentInput): Response => {
    const { action } = input.forwardedProps.orion;
    const ids = { threadId: input.threadId, runId: input.runId };
    const next = queued.get(action)?.shift();
    if (!next) {
      if (action === 'warmup' || action === 'viz_report') {
        const status = action === 'warmup' ? 'Warmed' : 'Recorded';
        return stream(sseOf([{ type: 'RUN_STARTED', ...ids }, { type: 'RUN_FINISHED', ...ids, result: { status, code: null } }]));
      }
      unexpected.push(input);
      return stream(sseOf([{ type: 'RUN_STARTED', ...ids }, { type: 'RUN_ERROR', code: 'NOT_IMPLEMENTED', message: `no reply for ${action}` }]));
    }
    if ('error' in next) {
      return jsonResponse(BFF_ERROR_STATUS[next.error], { error: { code: next.error, message: next.message ?? `the BFF said ${next.error}` } });
    }
    return 'hang' in next ? stream(next.hang, true) : stream(next.stream, false, next.hold);
  };

  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://bff.test');
    if ((init?.method ?? 'GET') === 'POST' && url.pathname === ORION_ROUTES.agui) {
      const parsed = JSON.parse(String(init?.body)) as RunAgentInput;
      turns.push(parsed);
      return turn(parsed);
    }
    gets.push(`${url.pathname}${url.search}`);
    const match = RUN_PATH.exec(url.pathname);
    const threadId = url.searchParams.get('threadId');
    const found = match
      ? match[2] === 'view'
        ? (untrimmed.get(match[1]) ?? views.get(match[1]))
        : records.get(match[1])
      : undefined;
    if (!found || (threadId !== null && found.threadId !== threadId)) {
      return jsonResponse(404, { error: { code: 'RUN_NOT_FOUND', message: 'No run with this runId is stored.' } });
    }
    return jsonResponse(200, found);
  };

  return {
    fetch: fetchImpl as typeof fetch,
    turns,
    gets,
    reply: (action, ...replies) => queued.set(action, [...(queued.get(action) ?? []), ...replies]),
    views,
    untrimmed,
    records,
    unexpected,
  };
};

/** A recorded stream with its ids (and nonces) replaced, for a run the fixtures only show part of. */
export const retargetStream = (text: string, replace: Record<string, string>): string =>
  Object.entries(replace).reduce((out, [from, to]) => out.split(from).join(to), text);

/** The frames of a recorded stream up to and including frame `count` (SSE frames end in a blank line). */
export const streamPrefix = (text: string, count: number): string => text.split('\n\n').slice(0, count).map((f) => `${f}\n\n`).join('');

/** Events as SSE bytes. */
export const sseText = sseOf;
