import React, { StrictMode } from 'react';
import { MantineProvider } from '@mantine/core';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from 'test-utils';
import type { ParseResult } from './agui/sseParser';
import { fixtureTransport, type RunTransport } from './agui/transport';
import type { AguiEvent, RunAgentInput, StateSnapshotEvent } from './agui/types';
import AssistantApp from './AssistantApp';
import { FIXTURE_NOTICE, REFERENCE_PROMPTS, SYNTHETIC_NOTICE } from './constants';
import { TAB_STORAGE_KEY } from './state/storage';
import { fixtureEvents } from './testing';

/** The fixture replay, recording every turn it was asked to run. */
const recordingTransport = (delayMs = 0) => {
  const inner = fixtureTransport({ delayMs });
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
const rejectingTransport = (
  reject: (input: RunAgentInput) => AguiEvent | null,
  delayMs = 0,
) => {
  const { transport: inner, turns } = recordingTransport(delayMs);
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

const renderApp = (transport: RunTransport, openApp?: (appId: string) => void) =>
  render(
    <StrictMode>
      <MantineProvider>
        <AssistantApp transport={transport} openApp={openApp} />
      </MantineProvider>
    </StrictMode>,
  );

beforeEach(() => window.sessionStorage.clear());

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
  });

  it('warms up once under strict mode, then runs a question to its answer', async () => {
    const { transport, turns } = recordingTransport();
    renderApp(transport);
    const box = await screen.findByRole('textbox', { name: 'Ask ORION' });
    await waitFor(() => expect(turns).toHaveLength(1));
    expect(turns[0].forwardedProps.orion.action).toBe('warmup');

    await userEvent.type(box, 'Compare survival by CGS risk{Enter}');
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

    expect(screen.getByText('Scope: All cases · 1,000 cases')).toBeInTheDocument();
    expect(screen.getAllByText('Interpretation withheld').length).toBeGreaterThan(0);
    expect(screen.getByRole('status')).toHaveTextContent('Answer ready: Interpretation withheld.');
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
    expect(screen.queryByText(REFERENCE_PROMPTS[0].text)).toBeNull();

    const saved = JSON.parse(window.sessionStorage.getItem(TAB_STORAGE_KEY) ?? 'null');
    expect(saved.threads[ask.threadId].runs[ask.runId].status).toBe('ObservedOnly');
  });

  it('shows no fixture notice for a transport that reaches the agent', async () => {
    const { transport: replay } = recordingTransport();
    renderApp({ run: (input, signal) => replay.run(input, signal) });
    expect(await screen.findByText(SYNTHETIC_NOTICE)).toBeInTheDocument();
    expect(screen.queryByText(FIXTURE_NOTICE)).toBeNull();
  });

  it('turns Send into Stop, sends cancel for the same run and ends Stopped by you', async () => {
    const { transport, turns } = recordingTransport(20);
    renderApp(transport);
    await userEvent.type(await screen.findByRole('textbox', { name: 'Ask ORION' }), 'q{Enter}');
    await waitFor(() => expect(actions(turns)).toEqual(['warmup', 'ask']));
    await userEvent.click(await screen.findByRole('button', { name: 'Stop' }));
    expect(await screen.findByText('Stopped by you')).toBeInTheDocument();
    expect(actions(turns)).toEqual(['warmup', 'ask', 'cancel']);
    expect(turns[2].runId).toBe(turns[1].runId);
    expect(screen.queryByText(/^Running/)).toBeNull();
    expect(screen.queryByText('Failed')).toBeNull();
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
  });

  it('withdraws an ask still waiting for the warm-up, sending neither it nor a cancel', async () => {
    const { transport, turns, release } = slowWarmupTransport();
    renderApp(transport);
    await userEvent.type(await screen.findByRole('textbox', { name: 'Ask ORION' }), 'q{Enter}');
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
    const box = await screen.findByRole('textbox', { name: 'Ask ORION' });
    await userEvent.type(box, 'Compare survival{Enter}');

    const notice = 'A run is still active in this thread. Wait for it to finish, then ask again.';
    expect(await within(conversation()).findByText(notice)).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(notice);
    expect(box).toHaveValue('Compare survival');
    expect(within(conversation()).queryByRole('article')).toBeNull();
    expect(screen.queryByText('Failed')).toBeNull();
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();

    await userEvent.type(box, '{Enter}');
    expect(await screen.findByText(/Interpretation withheld: /)).toBeInTheDocument();
    expect(within(conversation()).queryByText(notice)).toBeNull();
    expect(actions(turns)).toEqual(['warmup', 'ask', 'ask']);
    expect(turns[2].forwardedProps.orion).toMatchObject({ question: 'Compare survival' });
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
    await userEvent.type(await screen.findByRole('textbox', { name: 'Ask ORION' }), 'q{Enter}');
    await screen.findByRole('heading', { name: 'Plan, version 1' });
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));

    const notice =
      'Stop did not go through: ORION has no record of this run. The run shows the last status it reported.';
    expect(await within(conversation()).findByText(notice)).toBeInTheDocument();
    expect(actions(turns)).toEqual(['warmup', 'ask', 'cancel']);
    const plan = screen.getByRole('region', { name: 'Plan, version 1' });
    expect(within(plan).getAllByText('Running').length).toBeGreaterThan(0);
    expect(screen.queryByText('Stopping')).toBeNull();
    expect(screen.queryByText('Stopped by you')).toBeNull();
    expect(screen.queryByText('Failed')).toBeNull();
  });

  it('takes the question back when Stop comes before the first snapshot and the agent has no run', async () => {
    const { transport, turns } = unlaunchedAskTransport();
    renderApp(transport);
    const box = await screen.findByRole('textbox', { name: 'Ask ORION' });
    await userEvent.type(box, 'Compare survival{Enter}');
    await waitFor(() => expect(actions(turns)).toEqual(['warmup', 'ask']));
    await userEvent.click(await screen.findByRole('button', { name: 'Stop' }));

    const notice = 'ORION had not started this run, so there was nothing to stop. Ask again when you are ready.';
    expect(await within(conversation()).findByText(notice)).toBeInTheDocument();
    expect(actions(turns)).toEqual(['warmup', 'ask', 'cancel']);
    expect(turns[2].runId).toBe(turns[1].runId);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(notice));
    expect(box).toHaveValue('Compare survival');
    expect(within(conversation()).queryByRole('article')).toBeNull();
    expect(screen.queryByText('Planning')).toBeNull();
    expect(screen.queryByText('Failed')).toBeNull();
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();

    const saved = JSON.parse(window.sessionStorage.getItem(TAB_STORAGE_KEY) ?? 'null');
    expect(saved.threads[turns[1].threadId].runIds).toEqual([]);
  });

  it('offers the nearest app of an Unsupported answer and opens it on click', async () => {
    const openApp = jest.fn();
    renderApp(fixtureTransport({ stream: unsupportedStream(), delayMs: 0 }), openApp);
    await userEvent.type(await screen.findByRole('textbox', { name: 'Ask ORION' }), 'Venn please{Enter}');
    const open = await screen.findByRole('button', { name: 'Open on this cohort' });
    expect(screen.getByText('Set Operations')).toBeInTheDocument();
    expect(openApp).not.toHaveBeenCalled();
    await userEvent.click(open);
    expect(openApp).toHaveBeenCalledWith('SetOperations');
  });

  it('restores the thread from sessionStorage', async () => {
    const first = renderApp(recordingTransport().transport);
    await userEvent.type(await screen.findByRole('textbox', { name: 'Ask ORION' }), 'J1 please{Enter}');
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
      await userEvent.type(await screen.findByRole('textbox', { name: 'Ask ORION' }), 'q{Enter}');
      expect(await screen.findByText(/Interpretation withheld: /)).toBeInTheDocument();
    } finally {
      getItem.mockRestore();
      setItem.mockRestore();
    }
  });
});
