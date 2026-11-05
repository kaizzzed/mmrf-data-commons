import React, { type ReactElement, type ReactNode } from 'react';
import { readFileSync } from 'fs';
import path from 'path';
import { MantineProvider } from '@mantine/core';
import { render, type RenderResult } from '@testing-library/react';
import { cohortReducer, removeCohort, setCohortList, setCurrentCohortId, type Cohort, type CoreState } from '@gen3/core';
import { COHORT_FILTER_INDEX } from '@/core/constants';
import { createThread, threadReducer, type RunState, type ThreadState } from './agui/reducer';
import { createSseParser } from './agui/sseParser';
import type { AguiEvent, RunRecord, RunView, WireFilterSet } from './agui/types';
import { storeCohortPort, type CohortPort } from './cohort/cohortPort';
import { RunActionsContext, INERT_ACTIONS, type RunActions } from './components/RunActions';
import type { Notifier } from './handoff/notifier';

/** Test-only helpers; nothing in the app imports this module. */

export const FIXTURE_DIR = path.join(__dirname, 'agui', '__fixtures__');
export const FIXTURE_PATH = path.join(FIXTURE_DIR, 'j1-stub.events.jsonl');

export const readFixtureBytes = (): Uint8Array => new Uint8Array(readFileSync(FIXTURE_PATH));

export const fixtureEvents = (): AguiEvent[] => streamEvents('j1-stub');

/** The fifteen recorded streams of the contract (agui/__fixtures__). */
export const STREAM_NAMES = [
  'j1-stub',
  'j1-complete',
  'j1-partial',
  'j1-retry',
  'j1-stop',
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
