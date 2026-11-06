import React, { StrictMode } from 'react';
import { MantineProvider } from '@mantine/core';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { coreStore, selectCurrentCohortId, setCohortList, setCurrentCohortId, type Cohort } from '@gen3/core';
import { render } from 'test-utils';
import type { ParseResult } from './agui/sseParser';
import { fixtureTransport, TransportError, type FixtureTransportOptions, type RunRoutes, type RunTransport } from './agui/transport';
import type { AguiEvent, ConfirmPending, RunAgentInput, RunView, StateSnapshotEvent } from './agui/types';
import AssistantApp, { spikeRequested, type AssistantAppProps } from './AssistantApp';
import { memoryLedgerStore } from './cohort/saveLedger';
import { createWriteLog } from './cohort/writeLog';
import { FIXTURE_NOTICE, REFERENCE_PROMPTS, SYNTHETIC_NOTICE } from './constants';
import { createTab, tabReducer } from './state/tab';
import { saveTab, TAB_STORAGE_KEY } from './state/storage';
import {
  createTestCohortStore,
  fixtureEvents,
  recordingNotifier,
  replayStream,
  streamText,
  streamViews,
} from './testing';

jest.mock('./viz/VizCard', () => ({
  VizCard: ({ spec }: { spec: { vizId: string; title: string } }) => (
    <section aria-label={`Viz ${spec.vizId}`}>
      <h3>{spec.title}</h3>
    </section>
  ),
}));

jest.mock('./viz/spike/PpSpike', () => ({
  __esModule: true,
  default: () => <p>Viewer spike page</p>,
}));

/** The fixture replay, recording every turn it was asked to run. */
const recordingTransport = (options: FixtureTransportOptions = {}) => {
  const inner = fixtureTransport({ delayMs: 0, ...options });
  const turns: RunAgentInput[] = [];
  const transport: RunTransport = {
    replay: inner.replay,
    run(input, signal): AsyncIterable<ParseResult> {
      turns.push(input);
      return inner.run(input, signal);
    },
  };
  return { transport, turns };
};

/** The J3 journey: the save pause on ask, then whichever recorded reply the turn calls for. */
const j3Transport = (delayMs = 0) =>
  recordingTransport({
    delayMs,
    stream: streamText('j3-save-pause'),
    replies: { confirm: streamText('j3-after-confirm'), edit_plan: streamText('j3-edit-at-pause') },
  });

/** The same, but the warm-up stays open until `release` is called. */
const slowWarmupTransport = () => {
  const { transport: inner, turns } = recordingTransport();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const transport: RunTransport = {
    async *run(input, signal): AsyncGenerator<ParseResult> {
      if (input.forwardedProps.orion.action === 'warmup') await gate;
      yield* inner.run(input, signal);
    },
  };
  return { transport, turns, release: () => release() };
};

/** The fixture replay, except that the turns `reject` answers end in that RUN_ERROR. */
const rejectingTransport = (reject: (input: RunAgentInput) => AguiEvent | null, delayMs = 0) => {
  const { transport: inner, turns } = recordingTransport({ delayMs });
  const transport: RunTransport = {
    replay: true,
    async *run(input, signal): AsyncGenerator<ParseResult> {
      const rejection = reject(input);
      if (!rejection) {
        yield* inner.run(input, signal);
        return;
      }
      turns.push(input);
      yield { kind: 'event', event: { type: 'RUN_STARTED', threadId: input.threadId, runId: input.runId } };
      yield { kind: 'event', event: rejection };
    },
  };
  return { transport, turns };
};

/** An agent that never launches the ask (it streams nothing until aborted), so a cancel finds no run. */
const unlaunchedAskTransport = () => {
  const { transport: inner, turns } = recordingTransport();
  const transport: RunTransport = {
    async *run(input, signal): AsyncGenerator<ParseResult> {
      const { action } = input.forwardedProps.orion;
      if (action === 'warmup') {
        yield* inner.run(input, signal);
        return;
      }
      turns.push(input);
      if (action === 'ask') {
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
        return;
      }
      yield { kind: 'event', event: { type: 'RUN_STARTED', threadId: input.threadId, runId: input.runId } };
      yield {
        kind: 'event',
        event: { type: 'RUN_ERROR', code: 'RUN_NOT_FOUND', message: 'No run with this runId exists in this thread.' },
      };
    },
  };
  return { transport, turns };
};

/** A recorded stream whose run ends Unsupported, naming the nearest app. */
const unsupportedStream = (): string => {
  const [started, planning] = fixtureEvents();
  if (planning.type !== 'STATE_SNAPSHOT') throw new Error('fixture order changed');
  const view = planning.snapshot;
  const unsupported: StateSnapshotEvent = {
    type: 'STATE_SNAPSHOT',
    snapshot: {
      ...view,
      revision: 2,
      status: 'Unsupported',
      code: 'UNSUPPORTED_ANALYSIS',
      limitations: [
        {
          code: 'UNSUPPORTED_ANALYSIS',
          text: 'ORION cannot draw a Venn diagram.',
          unblock: null,
          nearestApps: [{ appId: 'SetOperations', title: 'Set Operations' }],
        },
      ],
    },
  };
  const finished: AguiEvent = {
    type: 'RUN_FINISHED',
    threadId: view.threadId,
    runId: view.runId,
    result: { status: 'Unsupported', code: 'UNSUPPORTED_ANALYSIS' },
  };
  return [started, unsupported, finished].map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
};

const actions = (turns: RunAgentInput[]) => turns.map((t) => t.forwardedProps.orion.action);

const conversation = () => screen.getByRole('log', { name: 'Conversation' });
const composer = () => screen.getByRole('textbox', { name: 'Ask ORION' });

const renderApp = (transport: RunTransport, props: Partial<AssistantAppProps> = {}) =>
  render(
    <StrictMode>
      <MantineProvider>
        <AssistantApp transport={transport} {...props} />
      </MantineProvider>
    </StrictMode>,
  );

/** The writes' store, ledger, log and notifier, all observable. */
const writes = () => {
  const cohorts = createTestCohortStore([{ id: 'c-all', name: 'Cohort' }]);
  const ledger = memoryLedgerStore();
  const log = createWriteLog(() => undefined);
  const notifier = recordingNotifier();
  return { cohorts, ledger, log, notifier, props: { cohorts: cohorts.port, ledger, log, notifier } };
};

const PAUSE = streamViews('j3-save-pause').pop() as RunView;
const PENDING = PAUSE.pending as ConfirmPending;

/** The confirmation card once its stream has ended: it waits, disabled, until then. */
const pausedCard = async (): Promise<HTMLElement> => {
  const card = await screen.findByRole('region', { name: 'Save 2 cohorts' });
  await waitFor(() => expect(within(card).getByRole('button', { name: 'Create' })).toBeEnabled());
  return card;
};

beforeEach(() => {
  window.sessionStorage.clear();
  window.history.replaceState({}, '', '/');
});

describe('<AssistantApp />', () => {
  it('shows the banner, the six starters and the scope chip on first use', async () => {
    renderApp(recordingTransport().transport);
    expect(await screen.findByText(SYNTHETIC_NOTICE)).toBeInTheDocument();
    expect(screen.getByText(FIXTURE_NOTICE)).toBeInTheDocument();
    for (const prompt of REFERENCE_PROMPTS) {
      expect(screen.getByText(prompt.text)).toBeInTheDocument();
    }
    expect(screen.getByText('Scope: All cases · count pending')).toBeInTheDocument();
    expect(screen.getByRole('log', { name: 'Conversation' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'ORION Assistant' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Threads in this tab' })).toBeInTheDocument();
  });

  it('warms up once under strict mode, then runs a question to its answer', async () => {
    const { transport, turns } = recordingTransport();
    renderApp(transport);
    await waitFor(() => expect(turns).toHaveLength(1));
    expect(turns[0].forwardedProps.orion.action).toBe('warmup');

    await userEvent.type(composer(), 'Compare survival by CGS risk{Enter}');
    expect(
      await screen.findByText('Interpretation withheld: Interpretation is not built yet (Day 1 stub)'),
    ).toBeInTheDocument();
    expect(turns).toHaveLength(2);
    const ask = turns[1];
    expect(ask.threadId).toBe(turns[0].threadId);
    expect(ask.runId).toMatch(/^[0-9a-f]{32}$/);
    expect(ask.messages).toEqual([
      { id: expect.stringMatching(/^[0-9a-f]{32}$/), role: 'user', content: 'Compare survival by CGS risk' },
    ]);
    expect(ask.forwardedProps.orion).toMatchObject({ action: 'ask', question: 'Compare survival by CGS risk' });

    // The Day 1 stub sizes its scope with no fact behind the count, so the line has no chip.
    expect(within(screen.getByRole('region', { name: 'Plan, version 1' })).getByText(/Scope: All cases ·/)).toHaveTextContent(
      'Scope: All cases · 1,000 cases',
    );
    expect(screen.getAllByText('Interpretation withheld').length).toBeGreaterThan(0);
    expect(screen.getByRole('status')).toHaveTextContent('Answer ready: Interpretation withheld.');
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
    expect(screen.queryByText(REFERENCE_PROMPTS[0].text)).toBeNull();
    expect(screen.getByRole('region', { name: 'Viz v1' })).toBeInTheDocument();

    const saved = JSON.parse(window.sessionStorage.getItem(TAB_STORAGE_KEY) ?? 'null');
    expect(saved.threads[ask.threadId].runs[ask.runId].status).toBe('ObservedOnly');
  });

  it('shows no fixture notice for a transport that reaches the agent', async () => {
    const { transport: replay } = recordingTransport();
    renderApp({ run: (input, signal) => replay.run(input, signal) });
    expect(await screen.findByText(SYNTHETIC_NOTICE)).toBeInTheDocument();
    expect(screen.queryByText(FIXTURE_NOTICE)).toBeNull();
  });

  it('turns Send into Stop, shows Stopping at once, sends cancel for the same run and ends Stopped by you (C-18)', async () => {
    const { transport, turns } = recordingTransport({ delayMs: 20 });
    renderApp(transport);
    await userEvent.type(composer(), 'q{Enter}');
    await waitFor(() => expect(actions(turns)).toEqual(['warmup', 'ask']));
    await screen.findByRole('heading', { name: 'Plan, version 1' });
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(screen.getByRole('button', { name: 'Stopping' })).toBeDisabled();
    expect(within(screen.getByRole('region', { name: 'Plan, version 1' })).getByText('Stopping')).toBeInTheDocument();
    expect(await screen.findAllByText('Stopped by you')).not.toHaveLength(0);
    expect(actions(turns)).toEqual(['warmup', 'ask', 'cancel']);
    expect(turns[2].runId).toBe(turns[1].runId);
    expect(screen.queryByText(/^Running/)).toBeNull();
    expect(screen.queryByText('Failed')).toBeNull();
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
  });

  it('offers Stop again when the cancel turn itself failed, and the resent cancel ends the run', async () => {
    const { transport: inner, turns } = recordingTransport({ delayMs: 20 });
    let failNextCancel = true;
    const transport: RunTransport = {
      replay: true,
      async *run(input, signal): AsyncGenerator<ParseResult> {
        if (input.forwardedProps.orion.action === 'cancel' && failNextCancel) {
          failNextCancel = false;
          turns.push(input);
          throw new TransportError('NETWORK', 'connection reset');
        }
        yield* inner.run(input, signal);
      },
    };
    renderApp(transport);
    await userEvent.type(composer(), 'q{Enter}');
    await screen.findByRole('heading', { name: 'Plan, version 1' });
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
    const again = await screen.findByRole('button', { name: 'Stop' });
    expect(again).toBeEnabled();
    expect(within(screen.getByRole('region', { name: 'Plan, version 1' })).getByText('Stopping')).toBeInTheDocument();
    await userEvent.click(again);
    expect(await screen.findAllByText('Stopped by you')).not.toHaveLength(0);
    expect(actions(turns)).toEqual(['warmup', 'ask', 'cancel', 'cancel']);
  });

  it('stops from Esc in the thread, as in the composer', async () => {
    const { transport, turns } = recordingTransport({ delayMs: 20 });
    renderApp(transport);
    await userEvent.type(composer(), 'q{Enter}');
    await screen.findByRole('heading', { name: 'Plan, version 1' });
    conversation().focus();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(actions(turns)).toContain('cancel'));
    expect(await screen.findAllByText('Stopped by you')).not.toHaveLength(0);
  });

  it('withdraws an ask still waiting for the warm-up, sending neither it nor a cancel', async () => {
    const { transport, turns, release } = slowWarmupTransport();
    renderApp(transport);
    await userEvent.type(composer(), 'q{Enter}');
    await userEvent.click(await screen.findByRole('button', { name: 'Stop' }));
    expect(await screen.findByText('Stopped by you')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();

    await act(async () => {
      release();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(actions(turns)).toEqual(['warmup']);
    expect(screen.getByText('Stopped by you')).toBeInTheDocument();
    expect(screen.queryByText('Failed')).toBeNull();
  });

  it('puts a rejected question back in the composer and says why, with no Failed run', async () => {
    let rejectNext = true;
    const { transport, turns } = rejectingTransport((input) => {
      if (input.forwardedProps.orion.action !== 'ask' || !rejectNext) return null;
      rejectNext = false;
      return { type: 'RUN_ERROR', code: 'RUN_BUSY', message: 'Another run is active in this thread.' };
    });
    renderApp(transport);
    await userEvent.type(composer(), 'Compare survival{Enter}');

    const notice = 'A run is still active in this thread. Wait for it to finish, then ask again.';
    expect(await within(conversation()).findByText(notice)).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(notice);
    expect(composer()).toHaveValue('Compare survival');
    expect(within(conversation()).queryByRole('article')).toBeNull();
    expect(screen.queryByText('Failed')).toBeNull();

    await userEvent.type(composer(), '{Enter}');
    expect(await screen.findByText(/Interpretation withheld: /)).toBeInTheDocument();
    expect(within(conversation()).queryByText(notice)).toBeNull();
    expect(actions(turns)).toEqual(['warmup', 'ask', 'ask']);
  });

  it('treats a BffError the browser rejects (503) as a rejected ask: the question goes back', async () => {
    const routes: RunRoutes = { view: jest.fn(), record: jest.fn(), recordDownloadHref: () => '' };
    const transport: RunTransport = {
      routes,
      async *run(input): AsyncGenerator<ParseResult> {
        if (input.forwardedProps.orion.action !== 'warmup') {
          throw new TransportError('BFF_ERROR', 'Runtime unavailable', 503, 'UPSTREAM_UNAVAILABLE');
        }
        // A warm-up streams nothing the app reads.
        yield* [];
      },
    };
    renderApp(transport);
    await userEvent.type(composer(), 'Compare survival{Enter}');
    expect(
      await within(conversation()).findByText('ORION is unavailable right now, so no run started. Try again later.'),
    ).toBeInTheDocument();
    expect(composer()).toHaveValue('Compare survival');
    expect(routes.view).not.toHaveBeenCalled();
    expect(screen.queryByText('Failed')).toBeNull();
  });

  it('leaves the run as it was when Stop is rejected, and says so', async () => {
    const { transport, turns } = rejectingTransport(
      (input) =>
        input.forwardedProps.orion.action === 'cancel'
          ? { type: 'RUN_ERROR', code: 'RUN_NOT_FOUND', message: 'No run with this runId exists in this thread.' }
          : null,
      20,
    );
    renderApp(transport);
    await userEvent.type(composer(), 'q{Enter}');
    await screen.findByRole('heading', { name: 'Plan, version 1' });
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));

    const notice =
      'Stop did not go through: ORION has no record of this run. The run shows the last status it reported.';
    expect(await within(conversation()).findByText(notice)).toBeInTheDocument();
    expect(actions(turns)).toEqual(['warmup', 'ask', 'cancel']);
    const plan = screen.getByRole('region', { name: 'Plan, version 1' });
    expect(within(plan).queryByText('Stopping')).toBeNull();
    expect(screen.queryByText('Stopped by you')).toBeNull();
    expect(screen.queryByText('Failed')).toBeNull();
  });

  it('takes the question back when Stop comes before the first snapshot and the agent has no run', async () => {
    const { transport, turns } = unlaunchedAskTransport();
    renderApp(transport);
    await userEvent.type(composer(), 'Compare survival{Enter}');
    await waitFor(() => expect(actions(turns)).toEqual(['warmup', 'ask']));
    await userEvent.click(await screen.findByRole('button', { name: 'Stop' }));

    const notice = 'ORION had not started this run, so there was nothing to stop. Ask again when you are ready.';
    expect(await within(conversation()).findByText(notice)).toBeInTheDocument();
    expect(actions(turns)).toEqual(['warmup', 'ask', 'cancel']);
    await waitFor(() => expect(composer()).toHaveValue('Compare survival'));
    expect(within(conversation()).queryByRole('article')).toBeNull();
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
  });

  it('offers the nearest app of an Unsupported answer and opens it on click', async () => {
    const openApp = jest.fn();
    renderApp(fixtureTransport({ stream: unsupportedStream(), delayMs: 0 }), { openApp });
    await userEvent.type(composer(), 'Venn please{Enter}');
    const open = await screen.findByRole('button', { name: 'Open on this cohort' });
    expect(screen.getByText('Set Operations')).toBeInTheDocument();
    expect(openApp).not.toHaveBeenCalled();
    await userEvent.click(open);
    expect(openApp).toHaveBeenCalledWith('SetOperations');
  });

  it('restores the thread from sessionStorage', async () => {
    const first = renderApp(recordingTransport().transport);
    await userEvent.type(composer(), 'J1 please{Enter}');
    await screen.findByText(/Interpretation withheld: /);
    first.unmount();

    renderApp(recordingTransport().transport);
    expect(await screen.findByText(/Interpretation withheld: /)).toBeInTheDocument();
    expect(screen.getAllByText('J1 please').length).toBeGreaterThan(0);
  });

  it('still works when sessionStorage throws', async () => {
    const getItem = jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const setItem = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    try {
      renderApp(recordingTransport().transport);
      await userEvent.type(composer(), 'q{Enter}');
      expect(await screen.findByText(/Interpretation withheld: /)).toBeInTheDocument();
    } finally {
      getItem.mockRestore();
      setItem.mockRestore();
    }
  });
});

describe('<AssistantApp /> thread restore from the view route', () => {
  it('reloads each run of the thread on return: the record wins, and an unstored run leaves', async () => {
    const paused = replayStream('j3-save-pause');
    const lost = 'c'.repeat(32);
    let tab = createTab(paused.threadId);
    tab = { ...tab, threads: { [paused.threadId]: paused } };
    tab = tabReducer(tab, { type: 'thread', threadId: paused.threadId, action: { type: 'submit', runId: lost, question: 'never stored', at: '2026-11-05T00:00:00.000Z' } });
    saveTab(tab);
    const pausedRunId = paused.runIds[0];
    const done = { ...(streamViews('j3-after-confirm').pop() as RunView), threadId: paused.threadId, runId: pausedRunId };
    const routes: RunRoutes = {
      view: jest.fn(async (runId: string) => {
        if (runId === lost) throw new TransportError('BFF_ERROR', 'no such run', 404, 'RUN_NOT_FOUND');
        return done;
      }),
      record: jest.fn(async () => {
        throw new TransportError('BFF_ERROR', 'no such run', 404, 'RUN_NOT_FOUND');
      }),
      recordDownloadHref: () => '/record',
    };
    renderApp({ routes, run: fixtureTransport({ delayMs: 0 }).run });
    expect(await screen.findByText('Complete')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Save 2 cohorts' })).toBeNull();
    await waitFor(() => expect(screen.queryByText('never stored')).toBeNull());
    // The question that never reached a run goes back to the composer.
    await waitFor(() => expect(composer()).toHaveValue('never stored'));
    expect(routes.view).toHaveBeenCalledWith(pausedRunId, paused.threadId);
  });
});

describe('<AssistantApp /> the save pause', () => {
  it('E21: Enter in the composer when the card appears saves nothing (C-17, FR-07)', async () => {
    const { transport, turns } = j3Transport(5);
    const w = writes();
    renderApp(transport, w.props);
    await userEvent.type(composer(), 'Differential expression by KRAS status{Enter}');
    await screen.findByRole('heading', { name: 'Plan, version 1' });
    // Typed while the run streams: the text waits, and keeps focus when the card appears.
    await userEvent.type(composer(), 'and then survival');
    expect(composer()).toHaveValue('and then survival');
    await screen.findByRole('heading', { name: 'Save 2 cohorts' });
    expect(composer()).toHaveFocus();
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Waiting for you: save 2 cohorts?'));
    // While the stream still runs, Enter only holds the text.
    await screen.findByRole('button', { name: 'Send' });
    expect(composer()).toHaveFocus();
    // The prompt takes focus as it appears, so the key press is awaited as one act.
    await act(async () => {
      await userEvent.keyboard('{Enter}');
    });
    // A new question at a pause asks first; nothing was saved and no confirm was sent.
    expect(screen.getByRole('heading', { name: 'Cancel the waiting run and send this, or keep it waiting?' })).toBeInTheDocument();
    expect(actions(turns)).not.toContain('confirm');
    expect(w.cohorts.port.list()).toHaveLength(1);
    expect(w.ledger.all()).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: 'Keep it waiting' }));
    expect(composer()).toHaveValue('and then survival');
    expect(actions(turns)).toEqual(['warmup', 'ask']);
  });

  it('Create saves both cohorts in the click, then confirms with the read-back bound to the nonce', async () => {
    const { transport, turns } = j3Transport();
    const w = writes();
    renderApp(transport, w.props);
    await userEvent.type(composer(), 'Differential expression by KRAS status{Enter}');
    const card = await pausedCard();
    expect(screen.getByRole('heading', { name: 'Save 2 cohorts' })).toHaveFocus();
    await userEvent.click(within(card).getByRole('checkbox', { name: /Make KRAS mutated/ }));
    await userEvent.click(within(card).getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(actions(turns)).toContain('confirm'));
    const confirm = turns.find((t) => t.forwardedProps.orion.action === 'confirm');
    const created = w.cohorts.port.list().filter((c) => c.id !== 'c-all');
    expect(created.map((c) => c.name).sort()).toEqual(['KRAS mutated (ORION)', 'KRAS not detected (ORION)']);
    expect(confirm?.runId).toBe(turns[1].runId);
    expect(confirm?.messages).toEqual([]);
    expect(confirm?.forwardedProps.orion).toEqual({
      action: 'confirm',
      nonce: PENDING.nonce,
      decision: 'create',
      makeActive: 'kras_mut',
      saved: PENDING.cohorts.map((c) => ({
        ref: c.ref,
        cohortId: created.find((s) => s.name === c.name)?.id,
        name: c.name,
        defSha256: c.defSha256,
        reused: false,
      })),
    });
    // The ledger holds the nonce; the make-active switch is a logged write with undo.
    expect(w.ledger.read(PENDING.nonce)?.cohorts.every((c) => c.cohortId !== null)).toBe(true);
    expect(w.log.entries().map((e) => [e.action, e.outcome])).toEqual([
      ['save_cohorts', 'created'],
      ['save_cohorts', 'created'],
      ['set_active_cohort', 'activated'],
    ]);
    expect(w.notifier.undos.map((u) => u.message)).toEqual(['Active cohort: KRAS mutated (ORION).']);
    expect(await screen.findByRole('region', { name: 'Viz v1' })).toBeInTheDocument();
    expect(await screen.findAllByText('Complete')).not.toHaveLength(0);
    expect(screen.queryByRole('region', { name: 'Save 2 cohorts' })).toBeNull();
  });

  it('Create reads trimmed definitions from the untrimmed view route, still inside the click', async () => {
    // A pause whose snapshot dropped every definition to fit 32 KB, with no save_cohorts tool call.
    const events = streamText('j3-save-pause')
      .split('\n\n')
      .filter((frame) => frame && !frame.includes('"TOOL_CALL_'))
      .map((frame) => {
        const event = JSON.parse(frame.slice('data: '.length)) as AguiEvent;
        if (event.type === 'STATE_SNAPSHOT' && event.snapshot.pending?.kind === 'confirm') {
          const pending = event.snapshot.pending;
          return { ...event, snapshot: { ...event.snapshot, pending: { ...pending, cohorts: pending.cohorts.map((c) => ({ ...c, definition: null })) } } };
        }
        return event;
      });
    const stream = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
    const inner = fixtureTransport({ delayMs: 0, stream, replies: { confirm: streamText('j3-after-confirm') } });
    const turns: RunAgentInput[] = [];
    const routes: RunRoutes = {
      view: jest.fn(async (runId: string, threadId: string) => ({ ...PAUSE, runId, threadId })),
      record: jest.fn(),
      recordDownloadHref: () => '',
    };
    const transport: RunTransport = {
      routes,
      run: (input, signal) => {
        turns.push(input);
        return inner.run(input, signal);
      },
    };
    const w = writes();
    renderApp(transport, w.props);
    await userEvent.type(composer(), 'DE by KRAS{Enter}');
    const card = await pausedCard();
    await userEvent.click(within(card).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(actions(turns)).toContain('confirm'));
    expect(routes.view).toHaveBeenCalledWith(turns[1].runId, turns[1].threadId);
    const confirm = turns.find((t) => t.forwardedProps.orion.action === 'confirm')?.forwardedProps.orion;
    expect(confirm).toMatchObject({ decision: 'create', nonce: PENDING.nonce });
    expect(w.cohorts.port.list()).toHaveLength(3);
  });

  it("Don't save confirms with no cohorts and writes nothing", async () => {
    const { transport, turns } = recordingTransport({
      stream: streamText('j3-save-pause'),
      replies: { confirm: streamText('j3-dont-save') },
    });
    const w = writes();
    renderApp(transport, w.props);
    await userEvent.type(composer(), 'DE by KRAS{Enter}');
    const card = await pausedCard();
    await userEvent.click(within(card).getByRole('button', { name: "Don't save" }));
    await waitFor(() => expect(actions(turns)).toContain('confirm'));
    expect(turns.at(-1)?.forwardedProps.orion).toEqual({
      action: 'confirm',
      nonce: PENDING.nonce,
      decision: 'dont_save',
      saved: [],
      makeActive: null,
    });
    expect(w.cohorts.port.list()).toHaveLength(1);
    expect(w.log.entries()).toEqual([]);
    expect(await screen.findByText("Skipped · Not saved: you chose Don't save")).toBeInTheDocument();
  });

  it('Rename sends an edit; the new version brings a new card for its new nonce, focused', async () => {
    const { transport, turns } = j3Transport();
    renderApp(transport, writes().props);
    await userEvent.type(composer(), 'DE by KRAS{Enter}');
    const card = await pausedCard();
    await userEvent.click(within(card).getByRole('button', { name: 'Rename KRAS not detected (ORION)' }));
    const field = within(card).getByRole('textbox', { name: 'New name for KRAS not detected (ORION)' });
    await userEvent.clear(field);
    await userEvent.type(field, 'KRAS wild-type (ORION)');
    await userEvent.click(within(card).getByRole('button', { name: 'Use this name' }));
    await waitFor(() => expect(actions(turns)).toContain('edit_plan'));
    expect(turns.at(-1)?.forwardedProps.orion).toEqual({
      action: 'edit_plan',
      field: 'cohortName',
      ref: 'kras_wt',
      value: 'KRAS wild-type (ORION)',
    });
    expect(await screen.findByRole('heading', { name: 'Plan, version 2' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'KRAS wild-type (ORION)' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Save 2 cohorts' })).toHaveFocus();
  });

  it('a new question at a pause can cancel the waiting run and go', async () => {
    const { transport, turns } = j3Transport();
    renderApp(transport, writes().props);
    await userEvent.type(composer(), 'DE by KRAS{Enter}');
    await pausedCard();
    await userEvent.type(composer(), 'Something else');
    await act(async () => {
      await userEvent.keyboard('{Enter}');
    });
    await userEvent.click(screen.getByRole('button', { name: 'Cancel the waiting run and send' }));
    await waitFor(() => expect(actions(turns)).toEqual(['warmup', 'ask', 'ask']));
    expect(turns[2].forwardedProps.orion).toMatchObject({ action: 'ask', question: 'Something else', cancelWaiting: turns[1].runId });
    expect(composer()).toHaveValue('');
  });
});

describe('<AssistantApp /> the pause prompt once its run moves on', () => {
  it("closes when the waiting run is answered on its card, so it never cancels a run that resumed", async () => {
    const { transport, turns } = j3Transport(5);
    renderApp(transport, writes().props);
    await userEvent.type(composer(), 'DE by KRAS{Enter}');
    const card = await pausedCard();
    await userEvent.type(composer(), 'Something else');
    await act(async () => {
      await userEvent.keyboard('{Enter}');
    });
    expect(screen.getByRole('button', { name: 'Cancel the waiting run and send' })).toBeInTheDocument();
    // The researcher answers the card instead: the run resumes, so the prompt no longer applies.
    await userEvent.click(within(card).getByRole('button', { name: "Don't save" }));
    expect(screen.queryByRole('button', { name: 'Cancel the waiting run and send' })).toBeNull();
    await waitFor(() => expect(actions(turns)).toContain('confirm'));
    expect(await screen.findAllByText('Complete')).not.toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Cancel the waiting run and send' })).toBeNull();
    // The typed question waits in the composer; no ask cancelled the resumed run.
    expect(composer()).toHaveValue('Something else');
    expect(actions(turns)).toEqual(['warmup', 'ask', 'confirm']);
  });
});

describe('<AssistantApp /> the Evidence Inspector', () => {
  it('opens from a chip on the step and its fact, and gives focus back on close', async () => {
    renderApp(recordingTransport().transport);
    await userEvent.type(composer(), 'J1{Enter}');
    const answer = await screen.findByRole('region', { name: 'Answer' });
    const chip = within(answer).getAllByRole('button', { name: 'Row 1 · s2 cohort_count' })[0];
    await userEvent.click(chip);
    const inspector = screen.getByRole('complementary', { name: 'Evidence Inspector' });
    expect(screen.getByRole('heading', { name: 'Evidence Inspector' })).toHaveFocus();
    expect(within(inspector).getByRole('heading', { name: 'Row 1 · s2 cohort_count' })).toBeInTheDocument();
    expect(within(inspector).getByText('The run record is not available in a fixture replay.')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('complementary', { name: 'Evidence Inspector' })).toBeNull();
    expect(chip).toHaveFocus();
  });
});

describe('<AssistantApp /> the composer scope chip', () => {
  const cohort = (id: string, name: string, root: Record<string, unknown> = {}): Cohort => ({
    id,
    name,
    filters: { case_centric: { mode: 'and', root } as unknown as Cohort['filters'][string] },
    createdDatetime: '2026-11-01T00:00:00.000Z',
    modifiedDatetime: '2026-11-01T00:00:00.000Z',
    counts: {},
  });

  it('makes a saved cohort active from a click, logged with the thread id, with undo', async () => {
    act(() => {
      coreStore.dispatch(
        setCohortList([
          cohort('c-all', 'Cohort'),
          cohort('c-black', 'Black patients', { race: { operator: 'includes', field: 'race', operands: ['black or african american'] } }),
        ]),
      );
      coreStore.dispatch(setCurrentCohortId('c-all'));
    });
    const notifier = recordingNotifier();
    const log = createWriteLog(() => undefined);
    renderApp(recordingTransport().transport, { notifier, log });
    await userEvent.click(screen.getByRole('button', { name: /Switch scope$/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Black patients · count pending' }));
    expect(selectCurrentCohortId(coreStore.getState())).toBe('c-black');
    expect(await screen.findByText('Scope: Black patients · count pending')).toBeInTheDocument();
    expect(log.entries()).toEqual([
      expect.objectContaining({ action: 'set_active_cohort', runId: null, stepId: null, detail: 'scope_chip', cohortId: 'c-black' }),
    ]);
    expect(log.entries()[0].threadId).toMatch(/^[0-9a-f]{32}$/);
    act(() => {
      expect(notifier.undos[0].onUndo()).toBe(true);
    });
    expect(selectCurrentCohortId(coreStore.getState())).toBe('c-all');
  });
});

describe('<AssistantApp /> next-step open links', () => {
  const cohort = (id: string, name: string): Cohort => ({
    id,
    name,
    filters: { case_centric: { mode: 'and', root: { race: { operator: 'in', field: 'race', operands: [name] } } } as unknown as Cohort['filters'][string] },
    createdDatetime: '2026-11-01T00:00:00.000Z',
    modifiedDatetime: '2026-11-01T00:00:00.000Z',
    counts: {},
  });

  /** The J1 answer, its scope the saved cohort `cohortId` rather than all cases. */
  const scopedStream = (cohortId: string): string =>
    streamText('j1-complete')
      .split('\n\n')
      .filter((frame) => frame.trim())
      .map((frame) => {
        const event = JSON.parse(frame.slice('data: '.length)) as AguiEvent;
        if (event.type !== 'STATE_SNAPSHOT') return frame;
        const cohorts = event.snapshot.cohorts.map((c) => (c.ref === 'base' ? { ...c, cohortId } : c));
        return `data: ${JSON.stringify({ ...event, snapshot: { ...event.snapshot, cohorts } })}`;
      })
      .map((frame) => `${frame}\n\n`)
      .join('');

  it("opens the app on the run's cohort, naming the active-cohort switch it makes (R3)", async () => {
    act(() => {
      coreStore.dispatch(setCohortList([cohort('c-all', 'Cohort'), cohort('c-scope', 'Scope cohort')]));
      coreStore.dispatch(setCurrentCohortId('c-all'));
    });
    const openApp = jest.fn();
    const notifier = recordingNotifier();
    const log = createWriteLog(() => undefined);
    renderApp(fixtureTransport({ stream: scopedStream('c-scope'), delayMs: 0 }), { openApp, notifier, log });
    await userEvent.type(composer(), 'Compare survival{Enter}');
    const open = await screen.findByRole('button', { name: 'Make active and open Cohort Comparison' });
    expect(openApp).not.toHaveBeenCalled();
    await userEvent.click(open);
    expect(selectCurrentCohortId(coreStore.getState())).toBe('c-scope');
    expect(openApp).toHaveBeenCalledWith('CohortComparison');
    expect(notifier.undos.map((u) => u.message)).toEqual(['Active cohort: Scope cohort.']);
    expect(log.entries()).toEqual([expect.objectContaining({ action: 'set_active_cohort', cohortId: 'c-scope' })]);
    act(() => {
      coreStore.dispatch(setCurrentCohortId('c-all'));
    });
  });
});

describe('the ?spike=pp page', () => {
  const env = process.env;
  afterEach(() => {
    process.env = env;
  });

  it('renders only when NEXT_PUBLIC_ORION_SPIKE is "1"', async () => {
    process.env = { ...env, NEXT_PUBLIC_ORION_SPIKE: '1' };
    expect(spikeRequested('?app=Assistant&spike=pp')).toBe(true);
    expect(spikeRequested('?app=Assistant')).toBe(false);
    window.history.replaceState({}, '', '/?app=Assistant&spike=pp');
    // The spike page is lazy, so it suspends once: render inside an awaited act.
    await act(async () => {
      renderApp(recordingTransport().transport);
    });
    expect(await screen.findByText('Viewer spike page')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Ask ORION' })).toBeNull();
  });

  it('shows the normal app otherwise', async () => {
    process.env = { ...env, NEXT_PUBLIC_ORION_SPIKE: '' };
    expect(spikeRequested('?spike=pp')).toBe(false);
    window.history.replaceState({}, '', '/?app=Assistant&spike=pp');
    renderApp(recordingTransport().transport);
    expect(await screen.findByRole('textbox', { name: 'Ask ORION' })).toBeInTheDocument();
    expect(screen.queryByText('Viewer spike page')).toBeNull();
  });
});
