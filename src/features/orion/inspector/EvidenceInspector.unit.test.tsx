import React from 'react';
import { MantineProvider } from '@mantine/core';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RunState } from '../agui/reducer';
import { TransportError, type RunRoutes } from '../agui/transport';
import type { RunRecord } from '../agui/types';
import { readRecord, renderWithMantine, replayedRun } from '../testing';
import { EvidenceInspector, type InspectorTarget } from './EvidenceInspector';
import { resolvePointer } from './jsonPointer';

const RECORD = readRecord('run-record.j1-complete.json');
const RUN: RunState = replayedRun('j1-complete');

const routesWith = (record: (runId: string) => Promise<RunRecord>): RunRoutes & { record: jest.Mock } => ({
  view: jest.fn(),
  record: jest.fn(record),
  recordDownloadHref: (runId, threadId) => `/api/orion/runs/${runId}/record?threadId=${threadId}&download=1`,
});

const renderInspector = (target: InspectorTarget, routes: RunRoutes | null, run: RunState = RUN) => {
  const onSelect = jest.fn();
  const onClose = jest.fn();
  const result = renderWithMantine(
    <EvidenceInspector threadId={RUN.view?.threadId ?? ''} target={target} run={run} routes={routes} onSelect={onSelect} onClose={onClose} />,
  );
  return { ...result, onSelect, onClose };
};

const inspector = () => screen.getByRole('complementary', { name: 'Evidence Inspector' });

describe('<EvidenceInspector />', () => {
  it('opens a chip\'s step, its call and the fact, from the view and the record route', async () => {
    const routes = routesWith(async () => RECORD);
    renderInspector({ runId: RUN.runId, stepId: 's2', factId: 'f.s2.count' }, routes);
    expect(screen.getByRole('heading', { name: 'Evidence Inspector' })).toHaveFocus();
    expect(within(inspector()).getByRole('heading', { name: 'Row 1 · s2 cohort_count' })).toBeInTheDocument();
    const fact = within(inspector()).getByRole('region', { name: 'Fact' });
    expect(within(fact).getByText('/observed/count')).toBeInTheDocument();
    expect(within(fact).getByText('339 cases')).toBeInTheDocument();
    const calls = within(inspector()).getByRole('region', { name: 'Calls' });
    await waitFor(() => expect(within(calls).getByRole('heading', { name: `${RUN.runId}.v1.s2.c1` })).toBeInTheDocument());
    // The fact's value, read at its pointer in the call it came from.
    await waitFor(() => expect(within(fact).getByText('339')).toBeInTheDocument());
    expect(within(fact).getByText(`${RUN.runId}.v1.s2.c1`)).toBeInTheDocument();
    expect(within(calls).getByText(/POST \/guppy\/graphql/)).toBeInTheDocument();
    expect(routes.record).toHaveBeenCalledWith(RUN.runId, RUN.view?.threadId, expect.any(AbortSignal));
    const link = screen.getByRole('link', { name: 'Export the run record as JSON' });
    expect(link).toHaveAttribute('href', `/api/orion/runs/${RUN.runId}/record?threadId=${RUN.view?.threadId}&download=1`);
    expect(link).toHaveAttribute('download', `orion-run-${RUN.runId}.json`);
  });

  it('lists the step\'s facts and moves to another one', async () => {
    const { onSelect } = renderInspector({ runId: RUN.runId, stepId: 's4', factId: 'f.s4.p' }, routesWith(async () => RECORD));
    const facts = within(inspector()).getByRole('region', { name: 'Facts from this step' });
    const buttons = within(facts).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(
      RUN.view?.facts.filter((f) => f.stepId === 's4').map((f) => expect.stringContaining(f.label)),
    );
    expect(within(facts).getByRole('button', { current: true })).toHaveTextContent('7.1e-60');
    await userEvent.click(buttons[0]);
    const firstFact = RUN.view?.facts.find((f) => f.stepId === 's4');
    expect(onSelect).toHaveBeenCalledWith({ runId: RUN.runId, stepId: 's4', factId: firstFact?.id });
    await screen.findAllByRole('heading', { name: /\.v1\.s4\.c/ });
  });

  it('shows a Reused step\'s calls from the version and step that produced them', async () => {
    const record: RunRecord = {
      ...RECORD,
      calls: RECORD.calls.map((c) => (c.stepId === 's2' ? { ...c, planVersion: 1 } : c)),
    };
    const run: RunState = RUN.view
      ? {
          ...RUN,
          view: {
            ...RUN.view,
            plan: RUN.view.plan && { ...RUN.view.plan, version: 2 },
            steps: RUN.view.steps.map((s) => (s.id === 's3' ? { ...s, status: 'Reused', reusedFrom: { planVersion: 1, stepId: 's2' } } : s)),
          },
        }
      : RUN;
    renderInspector({ runId: RUN.runId, stepId: 's3', factId: null }, routesWith(async () => record), run);
    expect(within(inspector()).getByText(/Reused from version 1, step s2/)).toBeInTheDocument();
    await screen.findByRole('heading', { name: `${RUN.runId}.v1.s2.c1` });
  });

  it('says the record is not available yet when the route answers RUN_NOT_FOUND', async () => {
    renderInspector(
      { runId: RUN.runId, stepId: 's2', factId: null },
      routesWith(async () => {
        throw new TransportError('BFF_ERROR', 'no such run', 404, 'RUN_NOT_FOUND');
      }),
    );
    expect(await within(inspector()).findByText('The run record is not available yet.')).toBeInTheDocument();
    // The step itself still shows, from the view.
    expect(within(inspector()).getByText(/CGS risk category = High risk/)).toBeInTheDocument();
  });

  it('says there is no record in a fixture replay, and offers no export', () => {
    renderInspector({ runId: RUN.runId, stepId: 's2', factId: null }, null);
    expect(within(inspector()).getByText('The run record is not available in a fixture replay.')).toBeInTheDocument();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('closes on Esc or its close button', async () => {
    const { onClose } = renderInspector({ runId: RUN.runId, stepId: 's2', factId: null }, null);
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: 'Close the Evidence Inspector' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('reads the record again when the run moves on', async () => {
    const routes = routesWith(async () => RECORD);
    const { rerender } = renderInspector({ runId: RUN.runId, stepId: 's2', factId: null }, routes);
    await waitFor(() => expect(routes.record).toHaveBeenCalledTimes(1));
    const next: RunState = RUN.view ? { ...RUN, view: { ...RUN.view, revision: RUN.view.revision + 1 } } : RUN;
    await act(async () => {
      rerender(
        <MantineProvider>
          <EvidenceInspector threadId={RUN.view?.threadId ?? ''} target={{ runId: RUN.runId, stepId: 's2', factId: null }} run={next} routes={routes} onSelect={jest.fn()} onClose={jest.fn()} />
        </MantineProvider>,
      );
    });
    await waitFor(() => expect(routes.record).toHaveBeenCalledTimes(2));
  });
});

describe('resolvePointer', () => {
  const doc = { observed: { groups: [{ count: 3 }], 'a/b': { '~c': 1 } } };
  it.each([
    ['', doc],
    ['/observed/groups/0/count', 3],
    ['/observed/a~1b/~0c', 1],
  ] as const)('resolves %s', (pointer, value) => {
    expect(resolvePointer(doc, pointer)).toEqual({ found: true, value });
  });

  it.each(['/observed/groups/1', '/observed/groups/01', '/nope', 'observed', '/observed/groups/0/count/x'])('misses %s', (pointer) => {
    expect(resolvePointer(doc, pointer)).toEqual({ found: false });
  });
});
