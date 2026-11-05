import React from 'react';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RunView, StateSnapshotEvent } from '../agui/types';
import { SYNTHETIC_NOTICE } from '../constants';
import { fixtureEvents, renderWithMantine } from '../testing';
import { AnswerCard } from './AnswerCard';

const SNAPSHOTS = fixtureEvents().filter(
  (e): e is StateSnapshotEvent => e.type === 'STATE_SNAPSHOT',
);
const FINAL: RunView = SNAPSHOTS[SNAPSHOTS.length - 1].snapshot;

const card = () => screen.getByRole('region', { name: 'Answer' });

const textOrder = (...texts: string[]) => {
  const content = card().textContent ?? '';
  return texts.map((t) => content.indexOf(t));
};

describe('<AnswerCard />', () => {
  it('labels each cited number "Row n · sN tool" from its fact', () => {
    renderWithMantine(<AnswerCard status="ObservedOnly" view={FINAL} />);
    expect(screen.getByText('Row 1 · s2 cohort_count')).toBeInTheDocument();
    expect(screen.getByText('Row 1 · s3 cohort_count')).toBeInTheDocument();
    expect(screen.getAllByText('Row 2 · s4 survival_compare')).toHaveLength(3);
    expect(within(card()).getByText('339')).toBeInTheDocument();
  });

  it('shows the withheld line between Observed and Limitations, then the synthetic notice', () => {
    renderWithMantine(<AnswerCard status="ObservedOnly" view={FINAL} />);
    const withheld = 'Interpretation withheld: Interpretation is not built yet (Day 1 stub)';
    expect(screen.getByText(withheld)).toBeInTheDocument();
    expect(screen.queryByText('Interpretation')).toBeNull();
    const positions = textOrder('Observed', withheld, 'Limitations', SYNTHETIC_NOTICE);
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(card().textContent?.endsWith(SYNTHETIC_NOTICE)).toBe(true);
  });

  it('falls back to a reason from the run status', () => {
    renderWithMantine(<AnswerCard status="Partial" view={{ ...FINAL, withheldReason: null }} />);
    expect(screen.getByText('Interpretation withheld: a step failed')).toBeInTheDocument();
  });

  it('shows "Writing interpretation" instead of a withheld line while Answering', () => {
    renderWithMantine(<AnswerCard status="Answering" view={{ ...FINAL, withheldReason: null }} />);
    expect(screen.getByText('Writing interpretation')).toBeInTheDocument();
    expect(screen.queryByText(/Interpretation withheld/)).toBeNull();
  });

  it('shows all four parts in order once interpretation passes', () => {
    const view: RunView = {
      ...FINAL,
      status: 'Complete',
      withheldReason: null,
      interpretation: [{ segments: [{ text: 'High risk cases fared worse in this cohort.' }] }],
      hypotheses: [{ segments: [{ text: 'Does this hold within ISS stage?' }] }],
    };
    renderWithMantine(<AnswerCard status="Complete" view={view} />);
    expect(screen.queryByText(/Interpretation withheld/)).toBeNull();
    const positions = textOrder('Observed', 'Interpretation', 'Hypotheses and next steps', 'Limitations');
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('makes chips buttons that cite their fact when a handler is given', async () => {
    const onCite = jest.fn();
    renderWithMantine(<AnswerCard status="ObservedOnly" view={FINAL} onCite={onCite} />);
    await userEvent.click(screen.getByRole('button', { name: 'Row 1 · s3 cohort_count' }));
    expect(onCite).toHaveBeenCalledWith('f.s3.count');
  });
});
