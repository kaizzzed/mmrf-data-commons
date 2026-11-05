import React from 'react';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Limitation } from '../agui/types';
import { renderWithMantine } from '../testing';
import { LimitationCard } from './LimitationCard';

const UNSUPPORTED: Limitation = {
  code: 'UNSUPPORTED_ANALYSIS',
  text: 'ORION cannot run this analysis.',
  unblock: 'Set Operations compares two cohorts as a Venn diagram.',
  nearestApps: [],
};

describe('<LimitationCard variant="unsupported" />', () => {
  it('makes no claim about apps when no nearest app is listed', () => {
    renderWithMantine(
      <LimitationCard variant="unsupported" limitations={[UNSUPPORTED]} onOpenOnCohort={jest.fn()} />,
    );
    expect(screen.getByText(UNSUPPORTED.unblock ?? '')).toBeInTheDocument();
    expect(screen.queryByText(/nearest app/i)).toBeNull();
    expect(screen.queryByText(/no virtual lab app/i)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open on this cohort' })).toBeNull();
  });

  it('names the first nearest app and opens it on this cohort on click', async () => {
    const onOpenOnCohort = jest.fn();
    const limitation: Limitation = {
      ...UNSUPPORTED,
      nearestApps: [
        { appId: 'SetOperations', title: 'Set Operations' },
        { appId: 'CohortComparison', title: 'Cohort Comparison' },
      ],
    };
    renderWithMantine(
      <LimitationCard variant="unsupported" limitations={[limitation]} onOpenOnCohort={onOpenOnCohort} />,
    );
    expect(screen.getByText('Set Operations')).toBeInTheDocument();
    expect(screen.queryByText('Cohort Comparison')).toBeNull();
    expect(onOpenOnCohort).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Open on this cohort' }));
    expect(onOpenOnCohort).toHaveBeenCalledWith('SetOperations');
  });
});

describe('<LimitationCard /> (Limited)', () => {
  it('lists what stopped the run without an app hand-off', () => {
    const limitation: Limitation = {
      code: 'NOT_IMPLEMENTED',
      text: 'This step is not built yet (Day 1 stub).',
      unblock: null,
      nearestApps: [{ appId: 'Correlation', title: 'Correlation Plot' }],
    };
    renderWithMantine(<LimitationCard limitations={[limitation]} />);
    expect(screen.getByText(limitation.text)).toBeInTheDocument();
    expect(screen.getByText('Stopped by a limitation')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open on this cohort' })).toBeNull();
  });
});
