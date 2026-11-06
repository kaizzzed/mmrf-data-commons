import React from 'react';
import { screen, within } from '@testing-library/react';
import type { RunState } from '../agui/reducer';
import { RUN_STATUS_VOCAB } from '../status';
import {
  mockActions,
  renderWithActions,
  replayStream,
  STREAM_NAMES,
  streamRunId,
  type StreamName,
} from '../testing';
import { RunItem } from './RunItem';

jest.mock('../viz/VizCard', () => ({
  VizCard: ({ spec }: { spec: { vizId: string; launcher: string; title: string } }) => (
    <section aria-label={`Viz ${spec.vizId}`}>
      <h3>{spec.title}</h3>
      <p>{spec.launcher}</p>
    </section>
  ),
}));

const EXPECTED: Record<StreamName, string> = {
  'j1-stub': 'ObservedOnly',
  'j1-complete': 'Complete',
  'j1-partial': 'Partial',
  'j1-retry': 'Complete',
  'j1-stop': 'Cancelled',
  'j2-save-pause': 'AwaitingConfirmation',
  'j2-after-confirm': 'Complete',
  'j2-dont-save': 'Complete',
  'j3-save-pause': 'AwaitingConfirmation',
  'j3-after-confirm': 'Complete',
  'j3-edit-at-pause': 'AwaitingConfirmation',
  'j3-dont-save': 'Complete',
  'j3-deinput': 'Complete',
  oncomatrix: 'Complete',
  clarify: 'Clarifying',
  consent: 'AwaitingConsent',
  interrupted: 'Unsupported',
  'cancel-waiting': 'Clarifying',
};

const runOf = (name: StreamName): RunState => replayStream(name).runs[streamRunId(name)];

const renderRun = (name: StreamName, overrides: Parameters<typeof mockActions>[0] = {}) => {
  const run = runOf(name);
  const actions = mockActions({ latestRunId: run.runId, ...overrides });
  renderWithActions(<RunItem run={run} />, actions);
  return { run, actions };
};

const plan = () => screen.getByRole('region', { name: /^Plan/ });
const answer = () => screen.getByRole('region', { name: 'Answer' });

describe('every fixture stream, replayed and rendered through the cards', () => {
  it.each(STREAM_NAMES)('%s shows its run word and resolves every chip', (name) => {
    const { run } = renderRun(name);
    expect(run.status).toBe(EXPECTED[name]);
    // Every state pairs its icon with one screen word (C-19).
    expect(screen.getAllByText(RUN_STATUS_VOCAB[run.status].word).length).toBeGreaterThan(0);
    expect(screen.queryByText(/^Unresolved/)).toBeNull();
    expect(screen.getByRole('article', { name: run.question })).toBeInTheDocument();
  });

  it('j1-complete: four labeled parts in order, chips, follow-ups, open link and the notice last', () => {
    const { actions } = renderRun('j1-complete');
    const text = answer().textContent ?? '';
    const order = ['Observed', 'Interpretation', 'Hypotheses and next steps', 'Limitations'].map((t) => text.indexOf(t));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text.endsWith('Synthetic sandbox — all data is fabricated and has no clinical meaning.')).toBe(true);
    expect(within(answer()).getAllByRole('button', { name: 'Row 2 · s4 survival_compare' }).length).toBeGreaterThan(1);
    within(answer()).getByRole('button', { name: 'Survival by ISS stage' }).click();
    expect(actions.askFollowUp).toHaveBeenCalledWith(expect.objectContaining({ question: 'Compare survival by ISS stage' }));
    within(answer()).getByRole('button', { name: 'Open Cohort Comparison' }).click();
    expect(actions.openLink).toHaveBeenCalledWith(runOf('j1-complete'), { appId: 'CohortComparison', title: 'Cohort Comparison' });
    expect(screen.getByRole('region', { name: 'Viz v1' })).toHaveTextContent('Overall survival by CGS risk category');
    // The scope line cites the fingerprint's case count.
    expect(within(plan()).getByText(/Scope: All cases ·/)).toHaveTextContent('Scope: All cases · 1,000Row 1 · s1 fixture_fingerprint cases');
  });

  it('j1-partial: the failed row with its code and Retry step, the skipped one with its reason', () => {
    const { actions, run } = renderRun('j1-partial');
    expect(within(plan()).getByText('Partial: a step failed')).toBeInTheDocument();
    expect(within(plan()).getByText(/^Failed · TOOL_FAILED/)).toBeInTheDocument();
    expect(within(plan()).getByText(/^Skipped · Not run: s4 failed/)).toBeInTheDocument();
    within(plan()).getByRole('button', { name: 'Retry step s4 survival_compare' }).click();
    expect(actions.retry).toHaveBeenCalledWith(run, 's4');
    expect(within(answer()).getByText('Interpretation withheld: a step failed')).toBeInTheDocument();
  });

  it('j1-partial: Retry step waits while a turn for the run is in flight', () => {
    const run = runOf('j1-partial');
    const { actions } = renderRun('j1-partial', { busyRunId: run.runId });
    const retry = within(plan()).getByRole('button', { name: 'Retry step s4 survival_compare' });
    expect(retry).toBeDisabled();
    retry.click();
    expect(actions.retry).not.toHaveBeenCalled();
  });

  it('j1-partial on an older run offers no Retry step', () => {
    renderRun('j1-partial', { latestRunId: 'someone-else' });
    expect(screen.queryByRole('button', { name: /^Retry step/ })).toBeNull();
  });

  it('j1-stop: Stopped by you, finished rows kept, the stopped ones skipped', () => {
    renderRun('j1-stop');
    expect(within(plan()).getByText('Stopped by you')).toBeInTheDocument();
    expect(within(plan()).getAllByText(/^Skipped · Not run: stopped/)).toHaveLength(2);
    expect(within(plan()).getAllByText(/^Done/).length).toBeGreaterThan(0);
    expect(within(answer()).getByText('Interpretation withheld: you stopped the run')).toBeInTheDocument();
  });

  it('j3-save-pause: Waiting for you, the save row Needs you, counts as chips, Create beside Don\'t save', () => {
    const { actions, run } = renderRun('j3-save-pause');
    const card = screen.getByRole('region', { name: 'Save 2 cohorts' });
    expect(within(plan()).getByText('Waiting for you')).toBeInTheDocument();
    expect(within(plan()).getAllByText('Needs you').length).toBeGreaterThan(0);
    expect(within(card).getByRole('button', { name: 'Row 3 · s5 set_operation' })).toBeInTheDocument();
    expect(within(card).getAllByRole('button', { name: 'Row 4 · s7 de_preanalysis' })).toHaveLength(2);
    expect(screen.getByRole('heading', { name: 'Save 2 cohorts' })).toHaveFocus();
    within(card).getByRole('button', { name: 'Create' }).click();
    expect(actions.create).toHaveBeenCalledWith(run, run.view?.pending, null);
    within(card).getByRole('button', { name: "Don't save" }).click();
    expect(actions.dontSave).toHaveBeenCalledWith(run, run.view?.pending);
    // Rows name their tools with the reason for each (C-35) and their steps (C-15).
    expect(
      within(plan()).getByText((_, el) => el?.tagName === 'P' && el.textContent === 'Tool: save_cohorts · Cohort Builder saves cohorts after your click'),
    ).toBeInTheDocument();
    expect(within(plan()).getByText('s9, s10')).toBeInTheDocument();
  });

  it('j3-edit-at-pause: version 2, reused steps from version 1, a new card for the new nonce', () => {
    renderRun('j3-edit-at-pause');
    expect(screen.getByRole('heading', { name: 'Plan, version 2' })).toBeInTheDocument();
    expect(within(plan()).getByText(/^Replaces version 1/)).toBeInTheDocument();
    expect(within(plan()).getAllByText('Reused · from version 1')).toHaveLength(7);
    expect(screen.getByRole('heading', { name: 'KRAS wild-type (ORION)' })).toBeInTheDocument();
  });

  it('j2-save-pause: one cohort to save last, its count a chip and no eligible count, no Observed yet', () => {
    const { actions, run } = renderRun('j2-save-pause');
    const card = screen.getByRole('region', { name: 'Save 1 cohort' });
    expect(within(card).getByRole('heading', { name: 'CGS high-risk (ORION)' })).toBeInTheDocument();
    expect(within(card).getByText('CGS risk category = High risk')).toBeInTheDocument();
    expect(within(card).queryByText(/RNA-seq eligible/)).toBeNull();
    expect(within(card).getByText('339')).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Row 1 · s2 cases_query' })).toBeInTheDocument();
    // The save is the plan's last step (s5), the one that waits for the researcher.
    expect(within(plan()).getAllByText('Waiting for you').length).toBeGreaterThan(0);
    expect(plan()).toHaveTextContent(/Needs you.*s5 save_cohorts/);
    expect(screen.queryByRole('region', { name: 'Answer' })).toBeNull();
    within(card).getByRole('button', { name: 'Create' }).click();
    expect(actions.create).toHaveBeenCalledWith(run, run.view?.pending, null);
  });

  it('j2-after-confirm: the save step Done, then the OncoMatrix card on the saved cohort, Complete', () => {
    renderRun('j2-after-confirm');
    expect(screen.queryByRole('region', { name: 'Save 1 cohort' })).toBeNull();
    expect(within(plan()).getByText(/1 cohort saved and read back/)).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Viz v1' })).toHaveTextContent('oncomatrix');
    expect(within(answer()).getByText('Observed')).toBeInTheDocument();
  });

  it("j2-dont-save: the one save Skipped with WRITE_SKIPPED, and the one-cohort limitation line", () => {
    renderRun('j2-dont-save');
    expect(within(plan()).getByText("Skipped · Not saved: you chose Don't save")).toBeInTheDocument();
    expect(within(answer()).getByText(/You chose Don't save/)).toBeInTheDocument();
  });

  it("j3-dont-save: the skipped save with its reason, and the WRITE_SKIPPED limitation", () => {
    renderRun('j3-dont-save');
    expect(within(plan()).getByText("Skipped · Not saved: you chose Don't save")).toBeInTheDocument();
    expect(within(answer()).getByText(/You chose Don't save, so no cohort was saved/)).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Viz v1' })).toHaveTextContent('deDirect');
  });

  it('clarify: one question, options as chips with a value preview, and Cancel', () => {
    const { actions, run } = renderRun('clarify');
    const card = screen.getByRole('region', { name: 'Which classification defines high risk?' });
    expect(screen.queryByRole('region', { name: /^Plan/ })).toBeNull();
    within(card).getByRole('button', { name: 'ISS stage: Stage I, Stage II, Stage III' }).click();
    expect(actions.clarify).toHaveBeenCalledWith(run, 'diagnoses.iss_stage');
    within(card).getByRole('button', { name: 'Cancel' }).click();
    expect(actions.cancel).toHaveBeenCalledWith(run);
  });

  it('consent: the plan with the proposed tool, the reason, and the choice', () => {
    const { actions, run } = renderRun('consent');
    expect(within(plan()).getByText('Needs your choice')).toBeInTheDocument();
    const card = screen.getByRole('region', { name: 'Use Correlation Plot instead of OncoMatrix?' });
    within(card).getByRole('button', { name: 'Use Correlation Plot' }).click();
    expect(actions.consent).toHaveBeenCalledWith(run, true);
    within(card).getByRole('button', { name: 'Cancel' }).click();
    expect(actions.consent).toHaveBeenCalledWith(run, false);
  });

  it('interrupted: the earlier run Interrupted with its finished rows, then the Unsupported card', () => {
    const thread = replayStream('interrupted');
    const [lost] = thread.runIds.filter((id) => id !== streamRunId('interrupted'));
    renderWithActions(<RunItem run={thread.runs[lost]} />, mockActions());
    expect(within(plan()).getByText('Interrupted')).toBeInTheDocument();
    expect(screen.getByText(/ORION lost this run before it finished/)).toBeInTheDocument();
    expect(within(plan()).getAllByText(/^Done/).length).toBeGreaterThan(0);
  });

  it('interrupted: Unsupported names the nearest app and opens it on this cohort', () => {
    const { actions, run } = renderRun('interrupted');
    const card = screen.getByRole('region', { name: 'This question is not supported' });
    expect(within(card).getByText('Set Operations')).toBeInTheDocument();
    within(card).getByRole('button', { name: 'Open on this cohort' }).click();
    expect(actions.openOnCohort).toHaveBeenCalledWith(run, 'SetOperations');
  });

  it('cancel-waiting: the paused run Stopped by you first, then the new question', () => {
    const thread = replayStream('cancel-waiting');
    const [paused] = thread.runIds.filter((id) => id !== streamRunId('cancel-waiting'));
    renderWithActions(<RunItem run={thread.runs[paused]} />, mockActions());
    expect(within(plan()).getByText('Stopped by you')).toBeInTheDocument();
    expect(within(plan()).getAllByText(/^Skipped · Not run: stopped/)).toHaveLength(5);
  });

  it('chips open the step and the fact in the Evidence Inspector', () => {
    const { actions, run } = renderRun('j1-complete');
    within(answer()).getAllByRole('button', { name: 'Row 1 · s3 cohort_count' })[0].click();
    expect(actions.inspect).toHaveBeenCalledWith({ runId: run.runId, stepId: 's3', factId: 'f.s3.count' });
    within(plan()).getByRole('button', { name: 'Inspect s4 survival_compare' }).click();
    expect(actions.inspect).toHaveBeenCalledWith({ runId: run.runId, stepId: 's4', factId: null });
  });
});
