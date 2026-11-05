import React from 'react';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Limitation } from '../agui/types';
import { SYNTHETIC_NOTICE } from '../constants';
import { renderWithMantine } from '../testing';
import { FailedCard } from './FailedCard';
import { LimitationCard } from './LimitationCard';

const UNSUPPORTED: Limitation = {
  code: 'UNSUPPORTED_ANALYSIS',
  text: 'ORION cannot run this analysis.',
  unblock: 'Set Operations compares two cohorts as a Venn diagram.',
  nearestApps: [],
};

describe('<LimitationCard variant="unsupported" />', () => {
  it('makes no claim about apps when no nearest app is listed', () => {
    renderWithMantine(<LimitationCard variant="unsupported" limitations={[UNSUPPORTED]} onOpenOnCohort={jest.fn()} />);
    expect(screen.getByText(UNSUPPORTED.unblock ?? '')).toBeInTheDocument();
    expect(screen.queryByText(/nearest app/i)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open on this cohort' })).toBeNull();
    expect(screen.getByText('Not supported')).toBeInTheDocument();
  });

  it('names the first nearest app and opens it on this cohort on click, ending with the notice', async () => {
    const onOpenOnCohort = jest.fn();
    const limitation: Limitation = {
      ...UNSUPPORTED,
      nearestApps: [
        { appId: 'SetOperations', title: 'Set Operations' },
        { appId: 'CohortComparison', title: 'Cohort Comparison' },
      ],
    };
    const { container } = renderWithMantine(
      <LimitationCard variant="unsupported" limitations={[limitation]} onOpenOnCohort={onOpenOnCohort} />,
    );
    expect(screen.getByText('Set Operations')).toBeInTheDocument();
    expect(screen.queryByText('Cohort Comparison')).toBeNull();
    expect(onOpenOnCohort).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Open on this cohort' }));
    expect(onOpenOnCohort).toHaveBeenCalledWith('SetOperations');
    expect(container.textContent?.endsWith(SYNTHETIC_NOTICE)).toBe(true);
  });

  it('keeps the hand-off button, disabled, with its reason', () => {
    const limitation: Limitation = { ...UNSUPPORTED, nearestApps: [{ appId: 'DE', title: 'Differential Gene Expression' }] };
    renderWithMantine(
      <LimitationCard limitations={[limitation]} onOpenOnCohort={jest.fn()} handoffDisabledReason="You chose Don't save." />,
    );
    expect(screen.getByRole('button', { name: 'Open on this cohort' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Open on this cohort' })).toHaveAccessibleDescription("You chose Don't save.");
  });
});

describe('<LimitationCard /> (Limited)', () => {
  it('lists what stopped the run, what would unblock it, and no hand-off without a handler', () => {
    const limitation: Limitation = {
      code: 'INELIGIBLE_GROUP',
      text: 'Too few RNA-seq-eligible samples.',
      unblock: 'Choose larger groups, such as a broader scope.',
      nearestApps: [{ appId: 'Correlation', title: 'Correlation Plot' }],
    };
    renderWithMantine(<LimitationCard limitations={[limitation]} />);
    expect(screen.getByText(limitation.text)).toBeInTheDocument();
    expect(screen.getByText('Choose larger groups, such as a broader scope.')).toBeInTheDocument();
    expect(screen.getByText('Stopped by a limitation')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open on this cohort' })).toBeNull();
  });
});

describe('<FailedCard />', () => {
  it.each([
    ['PLANNER_DECLINED', 'Could not plan', 'Rephrase the question, or ask again.'],
    ['WRITE_VERIFY_FAILED', 'The saved cohorts did not read back as planned', /cohorts the click created stay saved/],
    ['INTERNAL_ERROR', 'This run failed', 'Ask again, or rephrase the question.'],
  ] as const)('shows %s by its check', (code, title, next) => {
    renderWithMantine(<FailedCard code={code} message="It went wrong." />);
    expect(screen.getByRole('heading', { name: title })).toBeInTheDocument();
    expect(screen.getByText(next)).toBeInTheDocument();
    expect(screen.getByText(code)).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();
  });
});
