// The client against the contract, end to end: every fixture stream goes through a fake BFF
// behind the real httpTransport and httpRoutes, the run controller, the thread reducer and the
// rendered Assistant (real cards and viz cards; only ProteinPaint is mocked). The turns each card
// sends are compared with request-examples.json, ids included: the ids the browser makes up are
// fed from the examples, and so are the ids @gen3/core's own createNewCohort gives saved cohorts.
// The only values taken from the browser instead are its cohort snapshot (the store decides it)
// and, where the example could not know it, what the viz card measured.

import React, { StrictMode } from 'react';
import { readFileSync } from 'fs';
import path from 'path';
import { MantineProvider } from '@mantine/core';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  coreStore,
  selectAvailableCohorts,
  selectCurrentCohort,
  selectCurrentCohortId,
  setCohortList,
  setCurrentCohortId,
  type Cohort,
} from '@gen3/core';
import { render } from 'test-utils';
import { createThread, threadReducer } from './agui/reducer';
import { httpTransport } from './agui/transport';
import type {
  AguiEvent,
  CohortContext,
  ConfirmPending,
  OrionAction,
  RunAgentInput,
  RunView,
  VizReport,
} from './agui/types';
import AssistantApp from './AssistantApp';
import { storeCohortPort } from './cohort/cohortPort';
import { memoryLedgerStore } from './cohort/saveLedger';
import { toCohortContext } from './cohort/useCohortContext';
import { createWriteLog } from './cohort/writeLog';
import { saveTab } from './state/storage';
import { createTab, type TabState } from './state/tab';
import {
  createFakeBff,
  FIXTURE_DIR,
  readRecord,
  recordingNotifier,
  retargetStream,
  sseText,
  streamEvents,
  streamPrefix,
  streamText,
  streamViews,
  type FakeBff,
  type StreamName,
} from './testing';
import { deInputPinned, lastView } from './viz/testing';

// ------------------------------------------------------------------ ids and the viewer

/** Ids the browser makes up (newId), fed in order; random once the queue is empty. */
const mockIds: string[] = [];
jest.mock('./ids', () => {
  const actual = jest.requireActual<typeof import('./ids')>('./ids');
  return { ...actual, newId: () => mockIds.shift() ?? actual.newId() };
});

// Ids @gen3/core's createNewCohort gives new cohorts (its nanoid), fed in order. @gen3/core makes
// its generator, and its first cohort, while it loads, so the queue lives in the mocked module.
jest.mock('nanoid', () => {
  const actual = jest.requireActual<{ customAlphabet: (alphabet: string, size: number) => () => string }>('nanoid');
  const queue: string[] = [];
  return {
    ...actual,
    queue,
    customAlphabet: (alphabet: string, size: number) => {
      const next = actual.customAlphabet(alphabet, size);
      return () => queue.shift() ?? next();
    },
  };
});
const mockCohortIds = (jest.requireMock<{ queue: string[] }>('nanoid')).queue;

interface BindCall {
  rootElem: HTMLElement;
  initArgs: { holder: HTMLElement; opts?: { matrix?: { callbacks: Record<string, () => void> } }; [key: string]: unknown };
}
type Behaviour = (arg: BindCall) => Promise<{ triggerAbort: jest.Mock; destroy: jest.Mock } | undefined>;

/** A viewer that draws: content in the holder, and OncoMatrix's matrix postRender event. */
const mounts: Behaviour = (arg) => {
  arg.rootElem.appendChild(document.createElement('svg'));
  const rendered = arg.initArgs.opts?.matrix?.callbacks['postRender.orion'];
  if (rendered) setTimeout(rendered, 0);
  return Promise.resolve({ triggerAbort: jest.fn(), destroy: jest.fn() });
};

const mockBehaviours: Behaviour[] = [];
const mockBind = jest.fn((arg: BindCall) => (mockBehaviours.shift() ?? mounts)(arg));
jest.mock('@sjcrh/proteinpaint-client', () => ({ bindProteinPaint: (arg: BindCall) => mockBind(arg) }));

// ------------------------------------------------------------------ the contract's examples

const EXAMPLES = (
  JSON.parse(readFileSync(path.join(FIXTURE_DIR, 'request-examples.json'), 'utf8')) as {
    examples: { name: string; body: RunAgentInput }[];
  }
).examples;

const compared = new Set<string>();

const example = (name: string): RunAgentInput => {
  const found = EXAMPLES.find((e) => e.name.startsWith(name));
  if (!found) throw new Error(`no request example "${name}"`);
  compared.add(found.name);
  return found.body;
};


const orionOf = (body: RunAgentInput) => body.forwardedProps.orion as OrionAction & Record<string, unknown>;

/** The example with the browser's cohort snapshot in place of the one the example made up. */
const withContext = (body: RunAgentInput, cohortContext: CohortContext): RunAgentInput => ({
  ...body,
  forwardedProps: { orion: { ...orionOf(body), cohortContext } as OrionAction },
});

/** The cohort snapshot the store holds now, as the Assistant reads it (useCohortContext). */
const storeContext = (): CohortContext => {
  const state = coreStore.getState();
  return toCohortContext(selectCurrentCohort(state), selectAvailableCohorts(state));
};

const idsOf = (name: StreamName) => {
  const [started] = streamEvents(name);
  if (started.type !== 'RUN_STARTED') throw new Error(`${name} does not start with RUN_STARTED`);
  return { threadId: started.threadId, runId: started.runId };
};

/**
 * A resume's stream from a recorded run: the recording under this run's ids, its first frames
 * (before `from`) dropped and its revisions moved on so they follow `after`.
 */
const resumeStream = (name: StreamName, ids: { threadId: string; runId: string }, after: number, from: number): string => {
  const events = streamEvents(name);
  const firstRevision = events.slice(from).find((e) => e.type === 'STATE_SNAPSHOT');
  if (firstRevision?.type !== 'STATE_SNAPSHOT') throw new Error('no snapshot to resume from');
  const shift = after + 1 - firstRevision.snapshot.revision;
  const moved = events.slice(from).map((e): AguiEvent => {
    if (e.type === 'STATE_SNAPSHOT') return { ...e, snapshot: { ...e.snapshot, ...ids, revision: e.snapshot.revision + shift } };
    if (e.type === 'RUN_FINISHED') return { ...e, ...ids };
    return e;
  });
  return sseText([{ type: 'RUN_STARTED', ...ids }, ...moved]);
};

// ------------------------------------------------------------------ the app

const cohort = (id: string, name: string, root: Record<string, unknown> = {}, caseCount?: number): Cohort => ({
  id,
  name,
  filters: { case_centric: { mode: 'and', root } as unknown as Cohort['filters'][string] },
  createdDatetime: '2026-11-01T00:00:00.000Z',
  modifiedDatetime: '2026-11-01T00:00:00.000Z',
  counts: caseCount === undefined ? {} : { case_centric: caseCount },
});

const ALL = cohort('c-all', 'Cohort', {}, 1000);
const CGS_HIGH = cohort(
  '3c7a1e9b-5d2f-4b8a-9e6c-1f0d2a4b6c88',
  'CGS high-risk (ORION)',
  {
    'cgs_risk_key_criteria.cgs_risk_category': {
      operator: 'includes',
      field: 'cgs_risk_key_criteria.cgs_risk_category',
      operands: ['High risk'],
    },
  },
  339,
);

const seedStore = (cohorts: Cohort[], current: string) =>
  act(() => {
    coreStore.dispatch(setCohortList(null as unknown as Cohort[]));
    coreStore.dispatch(setCohortList(cohorts));
    coreStore.dispatch(setCurrentCohortId(current));
  });

/** The tab the Assistant restores: these threads, the first on screen. */
const seedTab = (...threads: ReturnType<typeof createThread>[]) => {
  const tab: TabState = {
    ...createTab(threads[0].threadId),
    threadIds: threads.map((t) => t.threadId),
    threads: Object.fromEntries(threads.map((t) => [t.threadId, t])),
  };
  saveTab(tab);
};

/** A thread holding this run as its snapshot shows it (a run the tab kept from before). */
const threadWith = (view: RunView) =>
  threadReducer(createThread(view.threadId), { type: 'STATE_SNAPSHOT', snapshot: view });

const renderApp = (bff: FakeBff) => {
  const transport = httpTransport({ fetchImpl: bff.fetch });
  const port = { ...storeCohortPort(coreStore), refreshCount: jest.fn() };
  const ledger = memoryLedgerStore();
  const log = createWriteLog(() => undefined);
  const notifier = recordingNotifier();
  const openApp = jest.fn();
  const view = render(
    <StrictMode>
      <MantineProvider>
        <AssistantApp transport={transport} cohorts={port} ledger={ledger} log={log} notifier={notifier} openApp={openApp} />
      </MantineProvider>
    </StrictMode>,
  );
  return { ...view, port, ledger, log, notifier, openApp };
};

const composer = () => screen.getByRole('textbox', { name: 'Ask ORION' });
const article = (question: string) => screen.getByRole('article', { name: question });
const planOf = (root: HTMLElement, version = 1) => within(root).getByRole('region', { name: `Plan, version ${version}` });
const answerOf = (root: HTMLElement) => within(root).getByRole('region', { name: 'Answer' });
const vizCard = (root: HTMLElement, vizId = 'v1') => within(root).getByTestId(`orion-viz-card-${vizId}`);
const vizPhase = (card: HTMLElement) => within(card).getByTestId(/^orion-viz-v\d+$/).getAttribute('data-phase');
/** A plan step's row, by its "sN tool" name. */
const stepRow = (plan: HTMLElement, name: string): HTMLElement => {
  const row = within(plan).getByText(name).closest('li');
  if (!row) throw new Error(`no step row for ${name}`);
  return row;
};
const stepRunning = (root: HTMLElement, name: string) =>
  expect(stepRow(planOf(root), name).textContent).toMatch(/^Running/);
const actionsOf = (bff: FakeBff) => bff.turns.map((t) => t.forwardedProps.orion.action);
const turnsOf = (bff: FakeBff, action: string) => bff.turns.filter((t) => t.forwardedProps.orion.action === action);

const ask = async (question: string) => {
  await userEvent.type(composer(), question);
  await userEvent.keyboard('{Enter}');
};

/** A waiting card once its stream has ended (its buttons wait for RUN_FINISHED). */
const waitingCard = async (name: string, button: string) => {
  const card = await screen.findByRole('region', { name });
  await waitFor(() => expect(within(card).getByRole('button', { name: button })).toBeEnabled());
  return card;
};

let bff: FakeBff;

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
  window.history.replaceState({}, '', '/?app=Assistant');
  mockIds.length = 0;
  mockCohortIds.length = 0;
  mockBehaviours.length = 0;
  mockBind.mockClear();
  bff = createFakeBff();
  seedStore([ALL], ALL.id);
});

afterEach(() => {
  expect(bff.unexpected).toEqual([]);
});

jest.setTimeout(30_000);

// ------------------------------------------------------------------ J1

describe('J1 through the BFF transport', () => {
  const J1 = idsOf('j1-complete');
  const J1_VIEW = lastView('j1-complete');
  const WARMUP = example('warmup');

  it('warms up, then streams the plan and live steps to a Complete answer with its four parts and a live card', async () => {
    let release: () => void = () => undefined;
    bff.reply('ask', { stream: streamText('j1-complete'), hold: { frames: 15, release: new Promise<void>((r) => (release = r)) } });
    seedTab(createThread(J1.threadId));
    mockIds.push(WARMUP.runId, J1.runId, 'e1'.repeat(16));
    renderApp(bff);

    await waitFor(() => expect(bff.turns).toHaveLength(1));
    expect(bff.turns[0]).toEqual(WARMUP);

    await ask(J1_VIEW.question);
    await waitFor(() => expect(actionsOf(bff)).toEqual(['warmup', 'ask']));
    expect(bff.turns[1]).toEqual({
      threadId: J1.threadId,
      runId: J1.runId,
      state: {},
      messages: [{ id: 'e1'.repeat(16), role: 'user', content: J1_VIEW.question }],
      tools: [],
      context: [],
      forwardedProps: { orion: { action: 'ask', question: J1_VIEW.question, cohortContext: storeContext() } },
    });

    // Held at s4: the plan card and its live steps, with Stop instead of Send.
    const run = article(J1_VIEW.question);
    await waitFor(() => stepRunning(run, 's4 survival_compare'));
    for (const done of ['s1 fixture_fingerprint', 's2 cohort_count', 's3 cohort_count']) {
      expect(stepRow(planOf(run), done).textContent).toMatch(/^Done/);
    }
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
    expect(within(run).queryByRole('region', { name: 'Answer' })).toBeNull();

    act(() => release());
    const answer = await within(run).findByRole('region', { name: 'Answer' });
    await waitFor(() => expect(within(planOf(run)).getAllByText('Complete').length).toBeGreaterThan(0));
    const text = answer.textContent ?? '';
    const order = ['Observed', 'Interpretation', 'Hypotheses and next steps', 'Limitations'].map((t) => text.indexOf(t));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text.endsWith(J1_VIEW.notice)).toBe(true);
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();

    // The real viz card mounts the pinned survival chart and matches its cited step.
    const card = vizCard(run);
    await waitFor(() => expect(vizPhase(card)).toBe('mounted'));
    expect(mockBind).toHaveBeenCalledTimes(1);
    expect(mockBind.mock.calls[0][0].initArgs).toHaveProperty('launchGdcCorrelation');
    expect(within(card).getByTestId('orion-viz-parity')).toHaveAttribute('data-parity', 'match');
    expect(within(card).getByRole('button', { name: 'Open with this cohort' })).toBeEnabled();
  });

  it("the card's report rides on the follow-up chip's ask; the OncoMatrix card opens the reused cohort", async () => {
    bff.reply('ask', { stream: streamText('j1-complete') }, { stream: streamText('oncomatrix') });
    seedStore([ALL, CGS_HIGH], ALL.id);
    seedTab(createThread(J1.threadId));
    const followUp = example('ask, the follow-up chip');
    mockIds.push(WARMUP.runId, J1.runId, 'e1'.repeat(16), followUp.runId, followUp.messages[0].id);
    const app = renderApp(bff);
    await ask(J1_VIEW.question);
    const j1 = await screen.findByRole('article', { name: J1_VIEW.question });
    await waitFor(() => expect(vizPhase(vizCard(j1))).toBe('mounted'));

    // Within 2 s of the report, the next turn carries it.
    await userEvent.click(within(answerOf(j1)).getByRole('button', { name: 'Top mutated genes in high-risk cases' }));
    await waitFor(() => expect(turnsOf(bff, 'ask')).toHaveLength(2));
    expect(turnsOf(bff, 'ask')[1]).toEqual(withContext(followUp, storeContext()));

    const onco = await screen.findByRole('article', { name: orionOf(followUp).question as string });
    const card = await within(onco).findByTestId('orion-viz-card-v1');
    await waitFor(() => expect(vizPhase(card)).toBe('mounted'));
    expect(within(card).getByTestId('orion-viz-pinned-to')).toHaveTextContent('Pinned to CGS high-risk (ORION)');
    // No save step: the plan reused the saved cohort at compile time.
    expect(within(onco).queryByRole('region', { name: /^Save/ })).toBeNull();

    // Hand-off: the reused cohort is not the active one, so it is made active (with undo), then the tool opens.
    await userEvent.click(within(card).getByRole('button', { name: 'Make active and open' }));
    expect(app.openApp).toHaveBeenCalledWith('OncoMatrix');
    expect(selectCurrentCohortId(coreStore.getState())).toBe(CGS_HIGH.id);
    expect(app.notifier.undos.map((u) => u.message)).toEqual(['Active cohort: CGS high-risk (ORION).']);
    expect(app.log.entries()).toEqual([
      expect.objectContaining({ action: 'set_active_cohort', threadId: J1.threadId, runId: followUp.runId, cohortId: CGS_HIGH.id }),
    ]);

    // The OncoMatrix card's own report goes standalone 2 s later: no turn came.
    await waitFor(() => expect(turnsOf(bff, 'viz_report')).toHaveLength(1), { timeout: 5000 });
    expect(turnsOf(bff, 'viz_report')[0]).toEqual({
      threadId: J1.threadId,
      runId: followUp.runId,
      state: {},
      messages: [],
      tools: [],
      context: [],
      forwardedProps: { orion: { action: 'viz_report', vizId: 'v1', mounted: true, error: null, pinnedHashVerified: true } },
    });
  });

  it('a viewer that fails reports it standalone, as the example (its parity was checked: true, not null)', async () => {
    bff.reply('ask', { stream: streamText('j1-complete') });
    seedTab(createThread(J1.threadId));
    mockIds.push(WARMUP.runId, J1.runId);
    mockBehaviours.push(() => Promise.reject(new Error('bindProteinPaint rejected: termdb/survival 503')));
    renderApp(bff);
    await ask(J1_VIEW.question);
    const run = await screen.findByRole('article', { name: J1_VIEW.question });
    await waitFor(() => expect(vizCard(run)).toHaveAttribute('data-stage', 'static'));
    expect(within(vizCard(run)).getByRole('button', { name: 'Try the live viewer again' })).toBeInTheDocument();
    // The frozen table keeps the cited numbers as chips, which open the Evidence Inspector.
    await userEvent.click(within(vizCard(run)).getAllByRole('button', { name: 'Row 1 · s2 cohort_count' })[0]);
    const inspector = screen.getByRole('complementary', { name: 'Evidence Inspector' });
    expect(within(inspector).getByRole('region', { name: 'Fact' })).toHaveTextContent('f.s2.count');
    await waitFor(() => expect(turnsOf(bff, 'viz_report')).toHaveLength(1), { timeout: 5000 });
    const standalone = example('viz_report, standalone');
    expect(turnsOf(bff, 'viz_report')[0]).toEqual({
      ...standalone,
      forwardedProps: { orion: { ...(orionOf(standalone) as Extract<OrionAction, { action: 'viz_report' }>), pinnedHashVerified: true } },
    });
  });

  it('opens the Evidence Inspector from a chip: the record route for its thread, the calls, the export link', async () => {
    bff.reply('ask', { stream: streamText('j1-complete') });
    bff.records.set(J1.runId, readRecord('run-record.j1-complete.json'));
    seedTab(createThread(J1.threadId));
    mockIds.push(WARMUP.runId, J1.runId);
    renderApp(bff);
    await ask(J1_VIEW.question);
    const run = await screen.findByRole('article', { name: J1_VIEW.question });
    const chip = within(await within(run).findByRole('region', { name: 'Answer' })).getAllByRole('button', {
      name: 'Row 1 · s2 cohort_count',
    })[0];
    await userEvent.click(chip);
    const inspector = screen.getByRole('complementary', { name: 'Evidence Inspector' });
    expect(within(inspector).getByRole('heading', { level: 2, name: 'Evidence Inspector' })).toHaveFocus();
    await within(inspector).findByRole('heading', { name: `${J1.runId}.v1.s2.c1` });
    expect(bff.gets).toContain(`/api/orion/runs/${J1.runId}/record?threadId=${J1.threadId}`);
    expect(within(inspector).getByRole('link', { name: 'Export the run record as JSON' })).toHaveAttribute(
      'href',
      `/api/orion/runs/${J1.runId}/record?threadId=${J1.threadId}&download=1`,
    );
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('complementary', { name: 'Evidence Inspector' })).toBeNull();
    expect(chip).toHaveFocus();
  });

  it('restores the thread on return from the view route: the record wins, an unstored run leaves', async () => {
    const lost = 'c'.repeat(32);
    const executing = streamViews('j1-complete')[3];
    const thread = threadReducer(threadWith(executing), { type: 'submit', runId: lost, question: 'never stored', at: '2026-11-05T00:00:00.000Z' });
    seedTab({ ...thread, invocation: null });
    bff.views.set(J1.runId, J1_VIEW);
    mockIds.push(WARMUP.runId);
    renderApp(bff);
    const run = await screen.findByRole('article', { name: J1_VIEW.question });
    await waitFor(() => expect(within(planOf(run)).getAllByText('Complete').length).toBeGreaterThan(0));
    await waitFor(() => expect(composer()).toHaveValue('never stored'));
    expect(screen.queryByRole('article', { name: 'never stored' })).toBeNull();
    expect(bff.gets).toEqual(
      expect.arrayContaining([
        `/api/orion/runs/${J1.runId}/view?threadId=${J1.threadId}`,
        `/api/orion/runs/${lost}/view?threadId=${J1.threadId}`,
      ]),
    );
  });

  it('j1-stub (the Day 1 reference) ends ObservedOnly with its withheld line', async () => {
    const stub = idsOf('j1-stub');
    bff.reply('ask', { stream: streamText('j1-stub') });
    seedTab(createThread(stub.threadId));
    mockIds.push('d0'.repeat(16), stub.runId);
    renderApp(bff);
    const question = lastView('j1-stub').question;
    await ask(question);
    const run = await screen.findByRole('article', { name: question });
    expect(await within(run).findByText('Interpretation withheld: Interpretation is not built yet (Day 1 stub)')).toBeInTheDocument();
  });
});

// ------------------------------------------------------------------ Stop, retry, the other pauses

describe('Stop, retry, clarify, consent and a new question at a pause', () => {
  it('Stop aborts the open stream and sends cancel for the same run (the example); the run ends Cancelled', async () => {
    const stop = example('cancel (Stop)');
    const ids = { threadId: stop.threadId, runId: stop.runId };
    const live = retargetStream(streamPrefix(streamText('j1-complete'), 15), {
      [idsOf('j1-complete').threadId]: ids.threadId,
      [idsOf('j1-complete').runId]: ids.runId,
    });
    bff.reply('ask', { hang: live });
    bff.reply('cancel', { stream: streamText('j1-stop') });
    seedTab(createThread(ids.threadId));
    mockIds.push('d1'.repeat(16), ids.runId);
    renderApp(bff);
    const question = lastView('j1-complete').question;
    await ask(question);
    const run = await screen.findByRole('article', { name: question });
    await waitFor(() => stepRunning(run, 's4 survival_compare'));
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(turnsOf(bff, 'cancel')).toHaveLength(1));
    expect(turnsOf(bff, 'cancel')[0]).toEqual(stop);
    expect(await within(planOf(run)).findAllByText('Stopped by you')).not.toHaveLength(0);
    expect(within(planOf(run)).getAllByText(/^Skipped · Not run: stopped/)).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
  });

  it('Retry step on a Partial run sends retry_step (the example) and the run completes', async () => {
    const retry = example('retry_step');
    const ids = idsOf('j1-partial');
    bff.reply('ask', { stream: streamText('j1-partial') });
    bff.reply('retry_step', { stream: streamText('j1-retry') });
    seedTab(createThread(ids.threadId));
    mockIds.push('d2'.repeat(16), ids.runId);
    renderApp(bff);
    const question = lastView('j1-partial').question;
    await ask(question);
    const run = await screen.findByRole('article', { name: question });
    const button = await within(planOf(run)).findByRole('button', { name: 'Retry step s4 survival_compare' });
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);
    await waitFor(() => expect(turnsOf(bff, 'retry_step')).toHaveLength(1));
    expect(turnsOf(bff, 'retry_step')[0]).toEqual(retry);
    expect(await within(run).findByRole('region', { name: 'Answer' })).toBeInTheDocument();
    await waitFor(() => expect(within(planOf(run)).getAllByText('Complete').length).toBeGreaterThan(0));
  });

  it('a clarifying option sends clarify_answer (the example), then the run goes on', async () => {
    const answer = example('clarify_answer');
    const ids = idsOf('clarify');
    bff.reply('ask', { stream: streamText('clarify') });
    bff.reply('clarify_answer', { stream: resumeStream('j1-complete', ids, lastView('clarify').revision, 1) });
    seedTab(createThread(ids.threadId));
    mockIds.push('d3'.repeat(16), ids.runId);
    renderApp(bff);
    const question = lastView('clarify').question;
    await ask(question);
    const card = await waitingCard('Which classification defines high risk?', 'CGS risk category: High risk, Standard risk');
    expect(within(card).getByRole('heading', { name: 'Which classification defines high risk?' })).toHaveFocus();
    await userEvent.click(within(card).getByRole('button', { name: 'CGS risk category: High risk, Standard risk' }));
    await waitFor(() => expect(turnsOf(bff, 'clarify_answer')).toHaveLength(1));
    expect(turnsOf(bff, 'clarify_answer')[0]).toEqual(answer);
    const run = screen.getByRole('article', { name: question });
    expect(await within(run).findByRole('region', { name: 'Answer' })).toBeInTheDocument();
  });

  it.each([
    ['accepted', 'Use Correlation Plot'],
    ['declined', 'Cancel'],
  ] as const)('consent %s: the card sends the example', async (which, button) => {
    const body = example(`consent, ${which}`);
    const ids = idsOf('consent');
    const view = lastView('consent');
    bff.reply('ask', { stream: streamText('consent') });
    const declined: RunView = {
      ...view,
      revision: view.revision + 1,
      status: 'Cancelled',
      code: null,
      pending: null,
      steps: view.steps.map((s) => ({ ...s, status: 'Skipped', outputSummary: 'Not run: you declined the substitution' })),
    };
    bff.reply(
      'consent',
      which === 'accepted'
        ? { stream: resumeStream('j1-complete', ids, view.revision, 3) }
        : {
            stream: sseText([
              { type: 'RUN_STARTED', ...ids },
              { type: 'STATE_SNAPSHOT', snapshot: declined },
              { type: 'RUN_FINISHED', ...ids, result: { status: 'Cancelled', code: null } },
            ]),
          },
    );
    seedTab(createThread(ids.threadId));
    mockIds.push('d4'.repeat(16), ids.runId);
    renderApp(bff);
    await ask(view.question);
    const card = await waitingCard('Use Correlation Plot instead of OncoMatrix?', button);
    await userEvent.click(within(card).getByRole('button', { name: button }));
    await waitFor(() => expect(turnsOf(bff, 'consent')).toHaveLength(1));
    expect(turnsOf(bff, 'consent')[0]).toEqual(body);
    const run = screen.getByRole('article', { name: view.question });
    if (which === 'accepted') expect(await within(run).findByRole('region', { name: 'Answer' })).toBeInTheDocument();
    else expect(await within(planOf(run)).findAllByText('Stopped by you')).not.toHaveLength(0);
  });

  it('a new question at a pause asks first, then sends ask with cancelWaiting (the example)', async () => {
    const body = example('ask that first cancels');
    const stream = streamText('cancel-waiting');
    const cancelled = streamViews('cancel-waiting')[0];
    // The paused run as the tab kept it, one revision before the stream cancels it.
    const paused: RunView = {
      ...cancelled,
      revision: cancelled.revision - 1,
      status: 'AwaitingConsent',
      code: 'NAMED_TOOL_MISMATCH',
      pending: lastView('consent').pending,
      withheldReason: null,
      steps: cancelled.steps.map((s) => ({ ...s, status: 'Queued', outputSummary: null })),
    };
    bff.views.set(paused.runId, paused);
    bff.reply('ask', { stream });
    seedTab(threadWith(paused));
    mockIds.push('d5'.repeat(16), body.runId, body.messages[0].id);
    renderApp(bff);
    await screen.findByRole('region', { name: 'Use Correlation Plot instead of OncoMatrix?' });
    await userEvent.type(composer(), orionOf(body).question as string);
    // The prompt takes focus as it appears, so the key press is awaited as one act.
    await act(async () => {
      await userEvent.keyboard('{Enter}');
    });
    expect(turnsOf(bff, 'ask')).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel the waiting run and send' }));
    await waitFor(() => expect(turnsOf(bff, 'ask')).toHaveLength(1));
    expect(turnsOf(bff, 'ask')[0]).toEqual(withContext(body, storeContext()));
    const earlier = screen.getByRole('article', { name: paused.question });
    expect(await within(planOf(earlier)).findAllByText('Stopped by you')).not.toHaveLength(0);
    const next = lastView('cancel-waiting').pending;
    if (next?.kind !== 'clarify') throw new Error('cancel-waiting ends Clarifying');
    expect(await screen.findByRole('region', { name: next.question })).toBeInTheDocument();
  });

  it('interrupted: the ask reports the earlier run Interrupted first, then its own Unsupported run', async () => {
    const ids = idsOf('interrupted');
    const [lostView, , unsupported] = streamViews('interrupted');
    // The tab kept the run Executing; its lease has lapsed, so the view route shows the rewrite.
    const executing: RunView = { ...lostView, revision: lostView.revision - 1, status: 'Executing', code: null };
    bff.views.set(executing.runId, lostView);
    bff.reply('ask', { stream: streamText('interrupted') });
    seedTab(threadWith(executing));
    mockIds.push('d6'.repeat(16), ids.runId);
    const app = renderApp(bff);
    await waitFor(() => expect(within(planOf(article(lostView.question))).getAllByText('Interrupted').length).toBeGreaterThan(0));
    await ask(unsupported.question);
    const card = await screen.findByRole('region', { name: 'This question is not supported' });
    await userEvent.click(within(card).getByRole('button', { name: 'Open on this cohort' }));
    expect(app.openApp).toHaveBeenCalledWith('SetOperations');
  });
});

// ------------------------------------------------------------------ J2 and J3: the save pause

describe('J2: one planned cohort, saved after one confirmation', () => {
  const J2 = idsOf('j2-save-pause');
  const PAUSE = lastView('j2-save-pause');
  const PENDING = PAUSE.pending as ConfirmPending;

  it('asks (the example), pauses at s5, Create saves the cohort in the click and confirms (the example), then Complete', async () => {
    const askBody = example('ask, J2');
    const confirm = example("confirm, Create of J2's one cohort");
    bff.reply('ask', { stream: streamText('j2-save-pause') });
    bff.reply('confirm', { stream: streamText('j2-after-confirm') });
    seedTab(createThread(J2.threadId));
    mockIds.push('d7'.repeat(16), J2.runId, askBody.messages[0].id);
    mockCohortIds.push(CGS_HIGH.id);
    const app = renderApp(bff);
    await ask(PAUSE.question);
    await waitFor(() => expect(turnsOf(bff, 'ask')).toHaveLength(1));
    expect(turnsOf(bff, 'ask')[0]).toEqual(withContext(askBody, storeContext()));

    const card = await waitingCard('Save 1 cohort', 'Create');
    // E21: focus on the heading, never a button; no form, so no default button.
    expect(within(card).getByRole('heading', { level: 3, name: 'Save 1 cohort' })).toHaveFocus();
    expect(card.querySelector('form')).toBeNull();
    expect(within(card).getAllByRole('button').every((b) => b.getAttribute('type') === 'button')).toBe(true);
    expect(within(card).queryByText(/RNA-seq eligible/)).toBeNull();
    expect(turnsOf(bff, 'confirm')).toEqual([]);

    await userEvent.click(within(card).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(turnsOf(bff, 'confirm')).toHaveLength(1));
    expect(turnsOf(bff, 'confirm')[0]).toEqual(confirm);
    // Saved by @gen3/core's own createNewCohort, counted the way the cohort bar counts, logged.
    const saved = selectAvailableCohorts(coreStore.getState()).find((c) => c.id === CGS_HIGH.id);
    expect(saved?.name).toBe(PENDING.cohorts[0].name);
    expect(app.port.refreshCount).toHaveBeenCalledWith(CGS_HIGH.id);
    expect(app.ledger.read(PENDING.nonce)?.cohorts.map((c) => c.cohortId)).toEqual([CGS_HIGH.id]);
    expect(app.log.entries().map((e) => [e.action, e.outcome])).toEqual([['save_cohorts', 'created']]);

    const run = screen.getByRole('article', { name: PAUSE.question });
    await waitFor(() => expect(within(planOf(run)).getAllByText('Complete').length).toBeGreaterThan(0));
    expect(within(run).queryByRole('region', { name: 'Save 1 cohort' })).toBeNull();
    const viz = vizCard(run);
    await waitFor(() => expect(vizPhase(viz)).toBe('mounted'));
    expect(mockBind.mock.calls[0][0].initArgs).toHaveProperty('launchGdcMatrix');
    expect(within(viz).getByTestId('orion-viz-pinned-to')).toHaveTextContent('Pinned to CGS high-risk (ORION)');
    await userEvent.click(within(viz).getByRole('button', { name: 'Make active and open' }));
    expect(app.openApp).toHaveBeenCalledWith('OncoMatrix');
    expect(selectCurrentCohortId(coreStore.getState())).toBe(CGS_HIGH.id);
  });

  it("Don't save sends confirm dont_save; the save is Skipped and the card's hand-off is off (C-16)", async () => {
    const ids = idsOf('j2-dont-save');
    const pause = retargetStream(streamText('j2-save-pause'), { [J2.threadId]: ids.threadId, [J2.runId]: ids.runId });
    bff.reply('ask', { stream: pause });
    bff.reply('confirm', { stream: streamText('j2-dont-save') });
    seedTab(createThread(ids.threadId));
    mockIds.push('d8'.repeat(16), ids.runId);
    const app = renderApp(bff);
    await ask(PAUSE.question);
    const card = await waitingCard('Save 1 cohort', "Don't save");
    await userEvent.click(within(card).getByRole('button', { name: "Don't save" }));
    await waitFor(() => expect(turnsOf(bff, 'confirm')).toHaveLength(1));
    expect(turnsOf(bff, 'confirm')[0]).toEqual({
      ...example("confirm, Don't save"),
      ...ids,
      forwardedProps: { orion: { action: 'confirm', nonce: PENDING.nonce, decision: 'dont_save', saved: [], makeActive: null } },
    });
    expect(selectAvailableCohorts(coreStore.getState()).map((c) => c.id)).toEqual([ALL.id]);
    const run = screen.getByRole('article', { name: PAUSE.question });
    await waitFor(() => expect(within(planOf(run)).getAllByText('Complete').length).toBeGreaterThan(0));
    const handoff = within(vizCard(run)).getByRole('button', { name: 'Open with this cohort' });
    expect(handoff).toBeDisabled();
    expect(within(vizCard(run)).getByTestId('orion-viz-handoff-reason')).toHaveTextContent(/Don't save/);
    expect(app.openApp).not.toHaveBeenCalled();
  });
});

describe('J3: two cohorts, the edits at the pause, Create with make-active, and the DE cards', () => {
  const J3 = idsOf('j3-save-pause');
  const PAUSE = lastView('j3-save-pause');
  const PENDING = PAUSE.pending as ConfirmPending;
  const KRAS_WT = '5f2c9a7e-1b3d-4e6f-8a0c-2d4b6e8f0a13';
  const KRAS_MUT = '9a1e3c5b-7d2f-4a6e-b8c0-4e6a8c0e2b57';

  it('asks (the example), and Create with make-active saves both in the click and confirms (the example); DE mounts', async () => {
    const askBody = example('ask, J3');
    bff.reply('ask', { stream: streamText('j3-save-pause') });
    bff.reply('confirm', { stream: streamText('j3-after-confirm') });
    seedTab(createThread(J3.threadId));
    mockIds.push('d9'.repeat(16), J3.runId, askBody.messages[0].id);
    mockCohortIds.push(KRAS_WT, KRAS_MUT);
    const app = renderApp(bff);
    await ask(PAUSE.question);
    await waitFor(() => expect(turnsOf(bff, 'ask')).toHaveLength(1));
    expect(turnsOf(bff, 'ask')[0]).toEqual(withContext(askBody, storeContext()));

    const card = await waitingCard('Save 2 cohorts', 'Create');
    expect(within(card).getAllByRole('heading', { level: 4 }).map((h) => h.textContent)).toEqual(PENDING.cohorts.map((c) => c.name));
    await userEvent.click(within(card).getByRole('checkbox', { name: /Make KRAS mutated \(ORION\) the active cohort/ }));
    await userEvent.click(within(card).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(turnsOf(bff, 'confirm')).toHaveLength(1));
    expect(turnsOf(bff, 'confirm')[0]).toEqual(example('confirm, Create with make-active'));
    expect(selectCurrentCohortId(coreStore.getState())).toBe(KRAS_MUT);
    expect(app.notifier.undos.map((u) => u.message)).toEqual(['Active cohort: KRAS mutated (ORION).']);
    expect(app.port.refreshCount.mock.calls.map(([id]) => id).sort()).toEqual([KRAS_MUT, KRAS_WT].sort());

    const run = screen.getByRole('article', { name: PAUSE.question });
    await waitFor(() => expect(within(planOf(run)).getAllByText('Complete').length).toBeGreaterThan(0));
    const viz = vizCard(run);
    await waitFor(() => expect(vizPhase(viz)).toBe('mounted'));
    expect(mockBind.mock.calls[0][0].initArgs).toHaveProperty('launchGdcDE');
    expect(within(viz).getByText('Table sorted by fold change. Sort by adjusted p-value to match the answer.')).toBeInTheDocument();
    // A DE card's two groups are picked inside the tool: it opens with no cohort switch.
    await userEvent.click(within(viz).getByRole('button', { name: 'Open with this cohort' }));
    expect(app.openApp).toHaveBeenCalledWith('DE');
    expect(selectCurrentCohortId(coreStore.getState())).toBe(KRAS_MUT);
  });

  it('each plan edit at the pause sends its example: method, top N, thresholds and scope', async () => {
    bff.reply('ask', { stream: streamText('j3-save-pause') });
    // An edit to the current value is a no-op the agent answers like a repeated confirm.
    const repeat = sseText([
      { type: 'RUN_STARTED', ...J3 },
      { type: 'STATE_SNAPSHOT', snapshot: PAUSE },
      { type: 'RUN_FINISHED', ...J3, result: { status: 'AwaitingConfirmation', code: null } },
    ]);
    bff.reply('edit_plan', { stream: repeat }, { stream: repeat }, { stream: repeat }, { stream: repeat });
    seedTab(createThread(J3.threadId));
    mockIds.push('da'.repeat(16), J3.runId);
    renderApp(bff);
    await ask(PAUSE.question);
    const card = await waitingCard('Save 2 cohorts', 'Create');
    const plan = planOf(article(PAUSE.question));
    await userEvent.click(within(plan).getByRole('button', { name: 'Edit settings' }));
    const apply = async (label: string) => {
      const button = within(plan).getByRole('button', { name: `Apply ${label}` });
      await waitFor(() => expect(button).toBeEnabled());
      const sent = turnsOf(bff, 'edit_plan').length;
      await userEvent.click(button);
      await waitFor(() => expect(turnsOf(bff, 'edit_plan')).toHaveLength(sent + 1));
      // The repeat ends the turn: the run's cards take clicks again.
      await waitFor(() => expect(within(card).getByRole('button', { name: 'Create' })).toBeEnabled());
      return turnsOf(bff, 'edit_plan')[sent];
    };

    await userEvent.selectOptions(within(plan).getByRole('combobox', { name: 'Method' }), 'edgeR');
    expect(await apply('Method')).toEqual(example('edit_plan, method'));

    const topN = within(plan).getByRole('spinbutton', { name: /^Top N/ });
    await userEvent.clear(topN);
    await userEvent.type(topN, '20');
    expect(await apply('Top N')).toEqual(example('edit_plan, top N'));

    const p = within(plan).getByRole('spinbutton', { name: 'p-value cutoff' });
    await userEvent.clear(p);
    await userEvent.type(p, '0.01');
    const fc = within(plan).getByRole('spinbutton', { name: '|log2FC| cutoff' });
    await userEvent.clear(fc);
    await userEvent.type(fc, '1');
    expect(await apply('Thresholds')).toEqual(example('edit_plan, thresholds'));

    await userEvent.selectOptions(within(plan).getByRole('combobox', { name: 'Scope' }), within(plan).getByRole('option', { name: 'All cases' }));
    expect(await apply('Scope')).toEqual(withContext(example('edit_plan, scope chip'), storeContext()));
  });

  it('Rename at the pause sends edit_plan cohortName (the example); the new version brings a new card, focused', async () => {
    const rename = example('edit_plan, rename at the save pause');
    const ids = { threadId: rename.threadId, runId: rename.runId };
    const pause = retargetStream(streamText('j3-save-pause'), { [J3.threadId]: ids.threadId, [J3.runId]: ids.runId });
    bff.reply('ask', { stream: pause });
    bff.reply('edit_plan', { stream: streamText('j3-edit-at-pause') });
    seedTab(createThread(ids.threadId));
    mockIds.push('db'.repeat(16), ids.runId);
    renderApp(bff);
    await ask(PAUSE.question);
    const card = await waitingCard('Save 2 cohorts', 'Create');
    await userEvent.click(within(card).getByRole('button', { name: 'Rename KRAS not detected (ORION)' }));
    const field = within(card).getByRole('textbox', { name: 'New name for KRAS not detected (ORION)' });
    await userEvent.clear(field);
    await userEvent.type(field, 'KRAS wild-type (ORION)');
    // Enter in the field does nothing: only the button renames.
    await userEvent.keyboard('{Enter}');
    expect(turnsOf(bff, 'edit_plan')).toEqual([]);
    await userEvent.click(within(card).getByRole('button', { name: 'Use this name' }));
    await waitFor(() => expect(turnsOf(bff, 'edit_plan')).toHaveLength(1));
    expect(turnsOf(bff, 'edit_plan')[0]).toEqual(rename);
    const run = article(PAUSE.question);
    await within(run).findByRole('heading', { name: 'Plan, version 2' });
    const fresh = await waitingCard('Save 2 cohorts', 'Create');
    expect(within(fresh).getByRole('heading', { level: 4, name: 'KRAS wild-type (ORION)' })).toBeInTheDocument();
    expect(within(fresh).getByRole('heading', { level: 3, name: 'Save 2 cohorts' })).toHaveFocus();
  });

  it("Don't save sends the example; DE runs on the proposed names, hand-off and the DEinput fallback off", async () => {
    const dontSave = example("confirm, Don't save");
    const ids = { threadId: dontSave.threadId, runId: dontSave.runId };
    const nonce = orionOf(dontSave).nonce as string;
    const pause = retargetStream(streamText('j3-save-pause'), {
      [J3.threadId]: ids.threadId,
      [J3.runId]: ids.runId,
      [PENDING.nonce]: nonce,
    });
    bff.reply('ask', { stream: pause });
    bff.reply('confirm', { stream: streamText('j3-dont-save') });
    seedTab(createThread(ids.threadId));
    mockIds.push('dc'.repeat(16), ids.runId);
    renderApp(bff);
    await ask(PAUSE.question);
    const card = await waitingCard('Save 2 cohorts', "Don't save");
    await userEvent.click(within(card).getByRole('button', { name: "Don't save" }));
    await waitFor(() => expect(turnsOf(bff, 'confirm')).toHaveLength(1));
    expect(turnsOf(bff, 'confirm')[0]).toEqual(dontSave);
    const run = article(PAUSE.question);
    await waitFor(() => expect(within(planOf(run)).getAllByText('Complete').length).toBeGreaterThan(0));
    expect(within(planOf(run)).getByText("Skipped · Not saved: you chose Don't save")).toBeInTheDocument();
    const viz = vizCard(run);
    expect(within(viz).getByRole('button', { name: 'Open with this cohort' })).toBeDisabled();
    expect(selectAvailableCohorts(coreStore.getState()).map((c) => c.id)).toEqual([ALL.id]);
  });

  it('j3-deinput: the trimmed card reads its pinned inputs from the view route before it mounts', async () => {
    const ids = idsOf('j3-deinput');
    const view = lastView('j3-deinput');
    expect(view.vizSpecs[0].pinned).toBeNull();
    const untrimmed: RunView = {
      ...view,
      vizSpecs: [{ ...view.vizSpecs[0], pinned: deInputPinned(lastView('j3-after-confirm')) }],
    };
    bff.reply('ask', { stream: streamText('j3-deinput') });
    bff.untrimmed.set(ids.runId, untrimmed);
    seedTab(createThread(ids.threadId));
    mockIds.push('dd'.repeat(16), ids.runId);
    renderApp(bff);
    await ask(view.question);
    const run = await screen.findByRole('article', { name: view.question });
    const viz = await within(run).findByTestId('orion-viz-card-v1');
    await waitFor(() => expect(vizPhase(viz)).toBe('mounted'));
    expect(bff.gets).toContain(`/api/orion/runs/${ids.runId}/view?threadId=${ids.threadId}`);
    expect(within(viz).getByTestId('orion-viz-parity')).toHaveAttribute('data-parity', 'match');
    await waitFor(() => expect(turnsOf(bff, 'viz_report')).toHaveLength(1), { timeout: 5000 });
    expect(orionOf(turnsOf(bff, 'viz_report')[0])).toMatchObject({ vizId: 'v1', mounted: true, pinnedHashVerified: true } satisfies Partial<VizReport>);
  });
});

// ------------------------------------------------------------------ BFF errors through the transport

describe('BFF errors as the transport parses them', () => {
  it('UNAUTHENTICATED: the ask is rejected with a notice to sign in again, and the question goes back', async () => {
    const ids = idsOf('j1-complete');
    bff.reply('ask', { error: 'UNAUTHENTICATED', message: 'Sign in to use ORION.' });
    seedTab(createThread(ids.threadId));
    mockIds.push('de'.repeat(16), ids.runId);
    renderApp(bff);
    await ask('Compare survival by CGS risk');
    expect(await screen.findByText('Your session has ended, so no run started. Sign in again, then ask again.')).toBeInTheDocument();
    await waitFor(() => expect(composer()).toHaveValue('Compare survival by CGS risk'));
    expect(screen.queryByRole('article', { name: 'Compare survival by CGS risk' })).toBeNull();
  });

  it('SESSION_BUSY on Stop: one view poll that shows the run unfinished resends the cancel', async () => {
    const stop = example('cancel (Stop)');
    const ids = { threadId: stop.threadId, runId: stop.runId };
    const live = retargetStream(streamPrefix(streamText('j1-complete'), 15), {
      [idsOf('j1-complete').threadId]: ids.threadId,
      [idsOf('j1-complete').runId]: ids.runId,
    });
    bff.reply('ask', { hang: live });
    bff.reply('cancel', { error: 'SESSION_BUSY' }, { stream: streamText('j1-stop') });
    seedTab(createThread(ids.threadId));
    mockIds.push('df'.repeat(16), ids.runId);
    renderApp(bff);
    const question = lastView('j1-complete').question;
    await ask(question);
    const run = await screen.findByRole('article', { name: question });
    await waitFor(() => stepRunning(run, 's4 survival_compare'));
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(turnsOf(bff, 'cancel')).toHaveLength(2), { timeout: 5000 });
    expect(turnsOf(bff, 'cancel')).toEqual([stop, stop]);
    expect(bff.gets).toContain(`/api/orion/runs/${ids.runId}/view?threadId=${ids.threadId}`);
    expect(await within(planOf(run)).findAllByText('Stopped by you')).not.toHaveLength(0);
  });
});

// Runs last (jest keeps declaration order): every request example of the contract was a turn a
// card or the composer sent above, compared in full.
describe('request-examples.json', () => {
  it('every example was compared with a turn the browser sent', () => {
    expect(EXAMPLES.map((e) => e.name).filter((name) => !compared.has(name))).toEqual([]);
  });
});
