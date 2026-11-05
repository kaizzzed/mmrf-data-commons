import React from 'react';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createThread, threadReducer, type RunState } from '../agui/reducer';
import type { RunView, Step } from '../agui/types';
import { fixtureEvents, renderWithMantine } from '../testing';
import { RunItem } from './RunItem';

/** The J1 fixture's finished run, with its view patched. */
const fixtureRun = (patch: (view: RunView) => Partial<RunState>): RunState => {
  const thread = fixtureEvents().reduce(threadReducer, createThread('4f0c1a9e2b7d4c3e8a6f5b1d0e9c2a7b'));
  const run = thread.runs[thread.runIds[0]];
  if (!run.view) throw new Error('the fixture run has no view');
  return { ...run, ...patch(run.view) };
};

const plan = () => screen.getByRole('region', { name: /^Plan/ });

describe('<RunItem />', () => {
  it('shows an Interrupted run with its finished rows and no stale connection note', () => {
    const run = fixtureRun((view) => ({
      status: 'Interrupted',
      code: 'RUN_INTERRUPTED',
      transportError: { code: 'STREAM_ENDED', message: 'the stream stopped' },
      view: {
        ...view,
        status: 'Interrupted',
        code: 'RUN_INTERRUPTED',
        observed: [],
        vizSpecs: [],
        steps: view.steps.map((s, i): Step => ({ ...s, status: i < 2 ? 'Done' : i === 2 ? 'Failed' : 'Skipped' })),
      },
    }));
    renderWithMantine(<RunItem run={run} onOpenApp={jest.fn()} />);
    expect(within(plan()).getByText('Interrupted')).toBeInTheDocument();
    expect(within(plan()).getAllByText(/^Done/).length).toBeGreaterThan(0);
    expect(screen.getByText(/ORION lost this run before it finished/)).toBeInTheDocument();
    expect(screen.getByText('RUN_INTERRUPTED')).toBeInTheDocument();
    expect(screen.queryByText(/Connection lost/)).toBeNull();
    expect(screen.queryByText('This run failed')).toBeNull();
  });

  it('hands an Unsupported question to the nearest app on click', async () => {
    const onOpenApp = jest.fn();
    const run = fixtureRun((view) => ({
      status: 'Unsupported',
      code: 'UNSUPPORTED_ANALYSIS',
      view: {
        ...view,
        status: 'Unsupported',
        observed: [],
        limitations: [
          {
            code: 'UNSUPPORTED_ANALYSIS',
            text: 'ORION cannot draw a Venn diagram.',
            unblock: null,
            nearestApps: [{ appId: 'SetOperations', title: 'Set Operations' }],
          },
        ],
      },
    }));
    renderWithMantine(<RunItem run={run} onOpenApp={onOpenApp} />);
    expect(screen.getByText('Set Operations')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Open on this cohort' }));
    expect(onOpenApp).toHaveBeenCalledWith('SetOperations');
  });

  it('says "count pending" when the plan scope has no count yet', () => {
    const run = fixtureRun((view) => ({
      view: view.plan
        ? { ...view, plan: { ...view.plan, scope: { ...view.plan.scope, caseCount: null } } }
        : view,
    }));
    renderWithMantine(<RunItem run={run} onOpenApp={jest.fn()} />);
    expect(within(plan()).getByText('Scope: All cases · count pending')).toBeInTheDocument();
  });
});
