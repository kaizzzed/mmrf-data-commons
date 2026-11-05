import React from 'react';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RunState } from '../agui/reducer';
import type { RunView, Step, VizSpec } from '../agui/types';
import type { VizCardProps } from '../viz/VizCard';
import { mockActions, renderWithActions, replayedRun } from '../testing';
import { RunItem } from './RunItem';

const mockVizProps: VizCardProps[] = [];

jest.mock('../viz/VizCard', () => ({
  VizCard: (props: VizCardProps) => {
    mockVizProps.push(props);
    return (
      <section aria-label={`Viz ${props.spec.vizId}`}>
        <h3>{props.spec.title}</h3>
        <button type="button" onClick={() => props.onOpenInTool(props.spec.appId, 'c-saved')}>
          Open with this cohort
        </button>
        <button
          type="button"
          onClick={() => props.onReport({ runId: props.run.runId, vizId: props.spec.vizId, mounted: true, error: null, pinnedHashVerified: true })}
        >
          Mounted
        </button>
      </section>
    );
  },
}));

beforeEach(() => {
  mockVizProps.length = 0;
});

/** A fixture's finished run, with its view patched. */
const patched = (name: Parameters<typeof replayedRun>[0], patch: (view: RunView) => Partial<RunState>): RunState => {
  const run = replayedRun(name);
  if (!run.view) throw new Error('the fixture run has no view');
  return { ...run, ...patch(run.view) };
};

const plan = () => screen.getByRole('region', { name: /^Plan/ });

describe('<RunItem />', () => {
  it('shows an Interrupted run with its finished rows and no stale connection note', () => {
    const run = patched('j1-stub', (view) => ({
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
    renderWithActions(<RunItem run={run} />, mockActions());
    expect(within(plan()).getByText('Interrupted')).toBeInTheDocument();
    expect(within(plan()).getAllByText(/^Done/).length).toBeGreaterThan(0);
    expect(screen.getByText(/ORION lost this run before it finished/)).toBeInTheDocument();
    expect(screen.getByText('RUN_INTERRUPTED')).toBeInTheDocument();
    expect(screen.queryByText(/Connection lost/)).toBeNull();
    expect(screen.queryByText('This run failed')).toBeNull();
  });

  it('says "count pending" when the plan scope has no count yet', () => {
    const run = patched('j1-stub', (view) => ({
      view: view.plan ? { ...view, plan: { ...view.plan, scope: { ...view.plan.scope, caseCount: null } } } : view,
    }));
    renderWithActions(<RunItem run={run} />, mockActions());
    expect(within(plan()).getByText('Scope: All cases · count pending')).toBeInTheDocument();
  });

  it('renders the viz builder\'s card for each viz spec, in the order the view gives', () => {
    const run = patched('j1-complete', (view) => ({
      view: {
        ...view,
        vizSpecs: [
          { ...view.vizSpecs[0], vizId: 'v2', title: 'Second' },
          { ...view.vizSpecs[0], vizId: 'v1', title: 'First' } as VizSpec,
        ],
      },
    }));
    const actions = mockActions();
    renderWithActions(<RunItem run={run} />, actions);
    expect(screen.getAllByRole('region', { name: /^Viz / }).map((r) => r.getAttribute('aria-label'))).toEqual(['Viz v2', 'Viz v1']);
    expect(mockVizProps.map((p) => [p.threadId, p.run, p.spec.vizId])).toEqual([
      [run.view?.threadId, run.view, 'v2'],
      [run.view?.threadId, run.view, 'v1'],
    ]);
    expect(mockVizProps[0].loadUntrimmedSpec).toBe(actions.loadUntrimmedSpec);
    // Esc inside a viewer is ProteinPaint's: each card sits in a data-orion-viz wrapper.
    expect(screen.getByRole('region', { name: 'Viz v1' }).closest('[data-orion-viz]')).not.toBeNull();
  });

  it('routes a card\'s hand-off and its viz report through the Assistant', async () => {
    const run = replayedRun('j1-complete');
    const actions = mockActions();
    renderWithActions(<RunItem run={run} />, actions);
    await userEvent.click(screen.getByRole('button', { name: 'Open with this cohort' }));
    expect(actions.openInTool).toHaveBeenCalledWith(run, run.view?.vizSpecs[0], 'Correlation', 'c-saved');
    await userEvent.click(screen.getByRole('button', { name: 'Mounted' }));
    expect(actions.reportViz).toHaveBeenCalledWith({ runId: run.runId, vizId: 'v1', mounted: true, error: null, pinnedHashVerified: true });
  });

  it('turns the nearest-app hand-off off after Don\'t save, saying why (C-16)', () => {
    const run = patched('j3-dont-save', (view) => ({
      status: 'Limited',
      view: {
        ...view,
        status: 'Limited',
        cohorts: view.cohorts.map((c) => (c.ref === 'base' ? { ...c, save: 'skipped' } : c)),
        limitations: [
          ...view.limitations,
          { code: 'UNSUPPORTED_FIELD', text: 'A filter cannot run here.', unblock: null, nearestApps: [{ appId: 'DE', title: 'Differential Gene Expression' }] },
        ],
      },
    }));
    renderWithActions(<RunItem run={run} />, mockActions());
    const card = screen.getByRole('region', { name: 'A limitation stopped this run' });
    const button = within(card).getByRole('button', { name: 'Open on this cohort' });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(/You chose Don't save/);
  });

  it('shows a failed run by its code, with no plan card when there was no plan', () => {
    const run: RunState = { ...replayedRun('clarify'), status: 'Failed', code: 'PLANNER_DECLINED', errorMessage: 'Both models declined.' };
    renderWithActions(<RunItem run={{ ...run, view: run.view && { ...run.view, pending: null } }} />, mockActions());
    expect(screen.getByRole('heading', { name: 'Could not plan' })).toBeInTheDocument();
    expect(screen.getByText('PLANNER_DECLINED')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /^Plan/ })).toBeNull();
  });

  it('notes a lost connection while the run may still finish', () => {
    const run = patched('j1-complete', (view) => ({
      status: 'Executing',
      transportError: { code: 'NETWORK', message: 'reset' },
      view: { ...view, status: 'Executing' },
    }));
    renderWithActions(<RunItem run={run} />, mockActions());
    expect(screen.getByRole('note')).toHaveTextContent('Connection lost (reset). The run may still finish on the server');
  });

  it('disables a waiting card while its turn is in flight', () => {
    const run = replayedRun('j3-save-pause');
    renderWithActions(<RunItem run={run} />, mockActions({ busyRunId: run.runId, latestRunId: run.runId }));
    const card = screen.getByRole('region', { name: 'Save 2 cohorts' });
    expect(within(card).getByRole('button', { name: 'Create' })).toBeDisabled();
  });
});
