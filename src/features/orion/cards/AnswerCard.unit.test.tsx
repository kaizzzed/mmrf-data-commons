import React from 'react';
import { MantineProvider } from '@mantine/core';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RunView } from '../agui/types';
import { SYNTHETIC_NOTICE } from '../constants';
import { renderWithMantine, streamViews } from '../testing';
import { AnswerCard } from './AnswerCard';

const STUB = streamViews('j1-stub').pop() as RunView;
const J1 = streamViews('j1-complete');
const ANSWERING = J1.find((v) => v.status === 'Answering') as RunView;
const COMPLETE = J1[J1.length - 1];

const card = () => screen.getByRole('region', { name: 'Answer' });

const textOrder = (...texts: string[]) => {
  const content = card().textContent ?? '';
  return texts.map((t) => content.indexOf(t));
};

describe('<AnswerCard />', () => {
  it('labels each cited number "Row n · sN tool" from its fact', () => {
    renderWithMantine(<AnswerCard status="ObservedOnly" view={STUB} />);
    expect(screen.getByText('Row 1 · s2 cohort_count')).toBeInTheDocument();
    expect(screen.getByText('Row 1 · s3 cohort_count')).toBeInTheDocument();
    expect(screen.getAllByText('Row 2 · s4 survival_compare')).toHaveLength(3);
    expect(within(card()).getByText('339')).toBeInTheDocument();
  });

  it('shows the four parts in order once interpretation passes, the notice last (C-10)', () => {
    renderWithMantine(<AnswerCard status="Complete" view={COMPLETE} />);
    const positions = textOrder('Observed', 'Interpretation', 'Hypotheses and next steps', 'Limitations', SYNTHETIC_NOTICE);
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(within(card()).getAllByRole('heading', { level: 4 }).map((h) => h.textContent)).toEqual([
      'Observed',
      'Interpretation',
      'Hypotheses and next steps',
      'Limitations',
    ]);
    expect(card().textContent?.endsWith(SYNTHETIC_NOTICE)).toBe(true);
  });

  it('shows Observed and Limitations with "Writing interpretation" while Answering (C-22)', () => {
    renderWithMantine(<AnswerCard status="Answering" view={ANSWERING} />);
    expect(screen.getByText('Writing interpretation')).toBeInTheDocument();
    expect(screen.queryByText(/Interpretation withheld/)).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Interpretation' })).toBeNull();
    const positions = textOrder('Observed', 'Writing interpretation', 'Limitations');
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('shows "Interpretation withheld: <reason>" between Observed and Limitations otherwise', () => {
    renderWithMantine(<AnswerCard status="ObservedOnly" view={STUB} />);
    const withheld = 'Interpretation withheld: Interpretation is not built yet (Day 1 stub)';
    expect(screen.getByText(withheld)).toBeInTheDocument();
    const positions = textOrder('Observed', withheld, 'Limitations', SYNTHETIC_NOTICE);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it.each([
    ['Partial', 'a step failed'],
    ['Cancelled', 'you stopped the run'],
    ['Interrupted', 'the run was interrupted'],
  ] as const)('falls back to a reason from the run status (%s)', (status, reason) => {
    renderWithMantine(<AnswerCard status={status} view={{ ...STUB, withheldReason: null }} />);
    expect(screen.getByText(`Interpretation withheld: ${reason}`)).toBeInTheDocument();
  });

  it('asks a follow-up chip as a new turn and opens other apps on click', async () => {
    const onAsk = jest.fn();
    const onOpenLink = jest.fn();
    renderWithMantine(<AnswerCard status="Complete" view={COMPLETE} onAsk={onAsk} onOpenLink={onOpenLink} />);
    const followUps = screen.getByRole('list', { name: 'Follow-up questions' });
    await userEvent.click(within(followUps).getByRole('button', { name: 'Top mutated genes in high-risk cases' }));
    expect(onAsk).toHaveBeenCalledWith(COMPLETE.followUps[1]);
    await userEvent.click(screen.getByRole('button', { name: 'Open Cohort Comparison' }));
    expect(onOpenLink).toHaveBeenCalledWith({ appId: 'CohortComparison', title: 'Cohort Comparison' });
  });

  it('names the active-cohort switch an open link makes, and keeps a link that cannot open off with its reason', async () => {
    const onOpenLink = jest.fn();
    const { rerender } = renderWithMantine(
      <AnswerCard
        status="Complete"
        view={COMPLETE}
        onOpenLink={onOpenLink}
        openLinkHandoff={() => ({ switches: true, cohortName: 'Black patients', disabledReason: null })}
      />,
    );
    const open = screen.getByRole('button', { name: 'Make active and open Cohort Comparison' });
    expect(open).toHaveAttribute('title', 'Makes Black patients the active cohort first');
    await userEvent.click(open);
    expect(onOpenLink).toHaveBeenCalledWith({ appId: 'CohortComparison', title: 'Cohort Comparison' });
    rerender(
      <MantineProvider>
        <AnswerCard
          status="Complete"
          view={COMPLETE}
          onOpenLink={onOpenLink}
          openLinkHandoff={() => ({ switches: false, cohortName: null, disabledReason: 'Not on this cohort.' })}
        />
      </MantineProvider>,
    );
    const off = screen.getByRole('button', { name: 'Open Cohort Comparison' });
    expect(off).toBeDisabled();
    expect(off).toHaveAccessibleDescription('Not on this cohort.');
  });

  it('marks a sentence the verifier dropped', () => {
    const view: RunView = { ...COMPLETE, interpretation: [...(COMPLETE.interpretation ?? []), { segments: [], dropped: 'V-NUM' }] };
    renderWithMantine(<AnswerCard status="Complete" view={view} />);
    expect(screen.getByText('A sentence was removed by the verifier (V-NUM): it stated a number no tool returned.')).toBeInTheDocument();
  });

  it('says the earlier version\'s answer was superseded (C-20)', () => {
    const view: RunView = {
      ...COMPLETE,
      superseded: [{ planVersion: 1, at: '2026-11-04T15:00:40.000Z', status: 'Complete', hadAnswer: true }],
    };
    renderWithMantine(<AnswerCard status="Complete" view={view} />);
    expect(screen.getByRole('note')).toHaveTextContent('This answer replaces the version 1 answer, which an edit superseded.');
  });

  it('renders a limitation that cites a number with its chips', () => {
    const view: RunView = {
      ...STUB,
      limitations: [
        {
          code: 'INELIGIBLE_GROUP',
          text: 'Too few cases: High risk has 339 cases.',
          unblock: 'Choose a split with larger groups.',
          nearestApps: [],
          segments: [{ text: 'Too few cases: High risk has ' }, { text: '339', factId: 'f.s2.count' }, { text: ' cases.' }],
        },
      ],
    };
    const onCite = jest.fn();
    renderWithMantine(<AnswerCard status="Limited" view={view} onCite={onCite} />);
    const limitations = screen.getByRole('heading', { name: 'Limitations' }).parentElement as HTMLElement;
    within(limitations).getByRole('button', { name: 'Row 1 · s2 cohort_count' }).click();
    expect(onCite).toHaveBeenCalledWith('f.s2.count');
    expect(within(limitations).getByText('Choose a split with larger groups.')).toBeInTheDocument();
  });
});
