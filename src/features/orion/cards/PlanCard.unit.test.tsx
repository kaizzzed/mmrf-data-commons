import React from 'react';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Plan, RunView, Step } from '../agui/types';
import { renderWithMantine, streamViews } from '../testing';
import { PlanCard, rowStatus, type PlanCardProps } from './PlanCard';
import type { ScopeOption } from './PlanEdits';
import { StepRow, stepDetail } from './StepRow';

const J3_PAUSE = streamViews('j3-save-pause').pop() as RunView;
const J1_DONE = streamViews('j1-complete').pop() as RunView;

const SCOPES: ScopeOption[] = [
  { label: 'All cases', choice: { source: 'all_cases' } },
  { label: 'Active cohort: All cases', choice: { source: 'active_cohort' } },
  { label: 'Black patients', choice: { source: 'saved_cohort', cohortName: 'Black patients' } },
];

const renderPlan = (props: Partial<PlanCardProps> = {}) => {
  const onEdit = jest.fn();
  const onRetry = jest.fn();
  const onCite = jest.fn();
  renderWithMantine(
    <PlanCard
      status="AwaitingConfirmation"
      view={J3_PAUSE}
      canEdit
      scopeOptions={SCOPES}
      onEdit={onEdit}
      onRetry={onRetry}
      onCite={onCite}
      {...props}
    />,
  );
  return { onEdit, onRetry, onCite };
};

const plan = () => screen.getByRole('region', { name: /^Plan/ });

describe('<PlanCard />', () => {
  it('shows the scope line above row 1, its count a chip once a step sized the scope', () => {
    const { onCite } = renderPlan();
    const line = within(plan()).getByText(/^Scope: All cases/);
    expect(line).toHaveTextContent('Scope: All cases · 1,000Row 1 · s1 fixture_fingerprint cases');
    within(line).getByRole('button', { name: 'Row 1 · s1 fixture_fingerprint' }).click();
    expect(onCite).toHaveBeenCalledWith('f.s1.cases');
  });

  it('says count pending before any count is known', () => {
    const plan0 = J3_PAUSE.plan as Plan;
    renderPlan({ view: { ...J3_PAUSE, plan: { ...plan0, scope: { ...plan0.scope, caseCount: null } } } });
    expect(screen.getByText('Scope: All cases · count pending')).toBeInTheDocument();
  });

  it('names both scopes after a cohort switch and switches with one click (C-01, E15)', async () => {
    const plan0 = J3_PAUSE.plan as Plan;
    const view: RunView = {
      ...J3_PAUSE,
      plan: {
        ...plan0,
        altScope: { source: 'active_cohort', name: 'Black patients', caseCount: 334 },
        altScopeChoice: { source: 'active_cohort' },
      },
    };
    const { onEdit } = renderPlan({ view });
    expect(screen.getByText('Also named: Black patients · 334 cases')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Switch scope to Black patients' }));
    expect(onEdit).toHaveBeenCalledWith({ field: 'scope', value: { source: 'active_cohort' } });
  });

  it('lists rows with their tools, the reason for each and their steps (C-35, C-15)', () => {
    renderPlan();
    const rows = within(screen.getByRole('list', { name: 'Plan rows' })).getAllByRole('listitem', { name: undefined });
    expect(rows.length).toBeGreaterThanOrEqual(6);
    expect(screen.getByText('Row 6 steps:').parentElement).toHaveTextContent('Row 6 steps: s9, s10');
    expect(screen.getByText('Differential Expression checks eligible samples before any save', { exact: false })).toBeInTheDocument();
    const row1 = screen.getByRole('list', { name: 'Steps in row 1' });
    // Folded steps lead their row.
    expect(within(row1).getAllByText(/^s\d+ /).map((el) => el.textContent)).toEqual(['s1 fixture_fingerprint', 's2 gene_cases']);
  });

  it('sends edits for the plan\'s editable settings, only once a value changed', async () => {
    const { onEdit } = renderPlan();
    await userEvent.click(screen.getByRole('button', { name: 'Edit settings' }));
    const apply = (label: string) => screen.getByRole('button', { name: `Apply ${label}` });
    expect(apply('Method')).toBeDisabled();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Method' }), 'edgeR');
    await userEvent.click(apply('Method'));
    expect(onEdit).toHaveBeenLastCalledWith({ field: 'method', value: 'edgeR' });

    const topN = screen.getByRole('spinbutton', { name: 'Top N' });
    expect(apply('Top N')).toBeDisabled();
    await userEvent.clear(topN);
    await userEvent.type(topN, '101');
    expect(apply('Top N')).toBeDisabled();
    await userEvent.clear(topN);
    await userEvent.type(topN, '20{Enter}');
    expect(onEdit).toHaveBeenCalledTimes(1);
    await userEvent.click(apply('Top N'));
    expect(onEdit).toHaveBeenLastCalledWith({ field: 'topN', value: 20 });

    await userEvent.clear(screen.getByRole('spinbutton', { name: 'p-value cutoff' }));
    await userEvent.type(screen.getByRole('spinbutton', { name: 'p-value cutoff' }), '0.01');
    await userEvent.click(apply('Thresholds'));
    expect(onEdit).toHaveBeenLastCalledWith({
      field: 'thresholds',
      value: { pValueCutoff: 0.01, pValueType: 'adjusted', foldChangeCutoff: 0.3 },
    });

    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Scope' }), screen.getByRole('option', { name: 'Black patients' }));
    await userEvent.click(apply('Scope'));
    expect(onEdit).toHaveBeenLastCalledWith({ field: 'scope', value: { source: 'saved_cohort', cohortName: 'Black patients' } });
    // The current scope (active cohort) is not offered again.
    expect(screen.queryByRole('option', { name: 'Active cohort: All cases' })).toBeNull();
  });

  it('offers no edits when the run cannot take one', () => {
    renderPlan({ canEdit: false });
    expect(screen.getByRole('button', { name: 'Edit settings' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /^Apply/ })).toBeNull();
  });

  it('marks a plan made by an edit and shows its reused steps', () => {
    const edited = streamViews('j3-edit-at-pause').pop() as RunView;
    renderPlan({ view: edited });
    expect(screen.getByRole('heading', { name: 'Plan, version 2' })).toBeInTheDocument();
    expect(screen.getByText(/^Replaces version 1/)).toBeInTheDocument();
    expect(screen.getAllByText('Reused · from version 1')).toHaveLength(7);
  });

  it('offers Retry step only where its caller allows it', () => {
    const steps = J1_DONE.steps.map((s): Step => (s.id === 's4' ? { ...s, status: 'Failed', code: 'TOOL_FAILED' } : s));
    const { onRetry } = renderPlan({
      status: 'Partial',
      view: { ...J1_DONE, steps },
      canRetry: (step) => step.status === 'Failed',
    });
    expect(screen.getAllByRole('button', { name: /^Retry step/ })).toHaveLength(1);
    screen.getByRole('button', { name: 'Retry step s4 survival_compare' }).click();
    expect(onRetry).toHaveBeenCalledWith('s4');
  });

  it('shows a placeholder while planning', () => {
    renderPlan({ status: 'Planning', view: null });
    expect(screen.getByRole('heading', { name: 'Plan' })).toBeInTheDocument();
    expect(screen.getByText('Planning')).toBeInTheDocument();
    expect(screen.getByText('The plan appears here before any tool runs.')).toBeInTheDocument();
  });
});

describe('rowStatus', () => {
  const step = (status: Step['status']): Step => ({ ...J1_DONE.steps[0], status });
  it.each([
    [['Done', 'Failed'], 'Failed'],
    [['Done', 'Retrying'], 'Retrying'],
    [['Done', 'Queued'], 'Running'],
    [['Queued', 'Queued'], 'Queued'],
    [['Done', 'Empty'], 'Empty'],
    [['Skipped', 'Skipped'], 'Skipped'],
    [['Reused', 'Reused'], 'Reused'],
    [['Reused', 'Done'], 'Done'],
    [['Done', 'AwaitingUser'], 'AwaitingUser'],
  ] as const)('%p reads %s', (statuses, expected) => {
    expect(rowStatus(statuses.map(step))).toBe(expected);
  });
});

describe('<StepRow />', () => {
  const base = J1_DONE.steps[3];

  it.each([
    [{ status: 'Retrying' }, 4000, 'Retrying · 4 s'],
    [{ status: 'Running' }, 1500, 'Running · 1 s'],
    [{ status: 'Done', durationMs: 1290 }, null, 'Done · 1.3 s'],
    [{ status: 'Skipped', outputSummary: 'Not run: s4 failed' }, null, 'Skipped · Not run: s4 failed'],
    [{ status: 'Empty', outputSummary: '0 cases' }, null, 'Empty · 0 cases'],
    [{ status: 'Failed', code: 'TOOL_FAILED' }, null, 'Failed · TOOL_FAILED'],
    [{ status: 'Reused', reusedFrom: { planVersion: 1, stepId: 's4' } }, null, 'Reused · from version 1'],
    [{ status: 'Reused', reusedFrom: { planVersion: 2, stepId: 's3' } }, null, 'Reused · from version 2 · s3'],
    [{ status: 'Queued' }, null, 'Next'],
    [{ status: 'AwaitingUser' }, null, 'Needs you'],
  ] as const)('writes %p as "%s"', (patch, elapsed, text) => {
    const step = { ...base, ...patch } as Step;
    const detail = stepDetail(step, elapsed);
    const word = { Retrying: 'Retrying', Running: 'Running', Done: 'Done', Skipped: 'Skipped', Empty: 'Empty', Failed: 'Failed', Reused: 'Reused', Queued: 'Next', AwaitingUser: 'Needs you' }[step.status];
    expect(detail ? `${word} · ${detail}` : word).toBe(text);
  });

  it('expands to the step JSON and back', async () => {
    renderWithMantine(<ul><StepRow step={base} /></ul>);
    await userEvent.click(screen.getByRole('button', { name: 'Show JSON' }));
    expect(screen.getByText(/"tool": "survival_compare"/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hide JSON' })).toHaveAttribute('aria-expanded', 'true');
  });
});
