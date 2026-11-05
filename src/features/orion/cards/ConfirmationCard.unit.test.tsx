import React, { useState } from 'react';
import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Composer } from '../components/Composer';
import { renderWithMantine } from '../testing';
import { ConfirmationCard, type PendingCohort } from './ConfirmationCard';

const COHORTS: PendingCohort[] = [
  {
    ref: 'c1',
    name: 'KRAS mutated',
    definition: 'Cases with a KRAS mutation',
    caseCount: 480,
    eligibleCount: 470,
    alreadySavedAs: null,
  },
  {
    ref: 'c2',
    name: 'KRAS not mutated',
    definition: 'Mutation-tested cases without a KRAS mutation',
    caseCount: 520,
    eligibleCount: 505,
    alreadySavedAs: 'KRAS wild type',
  },
];

const handlers = () => ({
  onCreate: jest.fn(),
  onRename: jest.fn(),
  onDontSave: jest.fn(),
  announce: jest.fn(),
});

describe('<ConfirmationCard />', () => {
  it('moves focus to its heading when it appears', () => {
    renderWithMantine(<ConfirmationCard cohorts={COHORTS} composerHasText={false} {...handlers()} />);
    expect(screen.getByRole('heading', { name: 'Save 2 cohorts' })).toHaveFocus();
    expect(screen.getByText('Waiting for you')).toBeInTheDocument();
  });

  it('has plain buttons only: no default, no submit, no autofocus', () => {
    const { container } = renderWithMantine(
      <ConfirmationCard cohorts={COHORTS} composerHasText={false} {...handlers()} />,
    );
    expect(container.querySelector('form')).toBeNull();
    expect(container.querySelector('[autofocus], [data-autofocus]')).toBeNull();
    const card = screen.getByRole('region', { name: 'Save 2 cohorts' });
    for (const name of ['Create', 'Rename', "Don't save"]) {
      const button = within(card).getByRole('button', { name });
      expect(button).toHaveAttribute('type', 'button');
      expect(button).not.toHaveFocus();
    }
  });

  it('shows names, definitions, counts, reuse and unchecked make-active boxes', () => {
    renderWithMantine(<ConfirmationCard cohorts={COHORTS} composerHasText={false} {...handlers()} />);
    expect(screen.getByText('Cases with a KRAS mutation')).toBeInTheDocument();
    expect(screen.getByText('480 cases · 470 RNA-seq eligible')).toBeInTheDocument();
    expect(screen.getByText('Already saved as KRAS wild type')).toBeInTheDocument();
    for (const box of screen.getAllByRole('checkbox', { name: 'Make active after saving' })) {
      expect(box).not.toBeChecked();
    }
  });

  it('lets at most one cohort be made active and passes it to Create', async () => {
    const h = handlers();
    renderWithMantine(<ConfirmationCard cohorts={COHORTS} composerHasText={false} {...h} />);
    const [first, second] = screen.getAllByRole('checkbox', { name: 'Make active after saving' });
    await userEvent.click(first);
    await userEvent.click(second);
    expect(first).not.toBeChecked();
    expect(second).toBeChecked();
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(h.onCreate).toHaveBeenCalledWith('c2');
    await userEvent.click(screen.getByRole('button', { name: "Don't save" }));
    expect(h.onDontSave).toHaveBeenCalledTimes(1);
  });

  it('leaves focus in a composer holding text, announces itself, and Enter never saves', async () => {
    const h = handlers();
    const Page = () => {
      const [value, setValue] = useState('');
      const [shown, setShown] = useState(false);
      return (
        <>
          <Composer
            value={value}
            onChange={setValue}
            onSend={() => undefined}
            onStop={() => undefined}
            running
            scopeLabel="Scope: All cases · 1,000 cases"
          />
          <button type="button" onClick={() => setShown(true)} hidden>
            show
          </button>
          {shown && (
            <ConfirmationCard cohorts={COHORTS} composerHasText={value.trim() !== ''} {...h} />
          )}
        </>
      );
    };
    renderWithMantine(<Page />);
    const box = screen.getByRole('textbox', { name: 'Ask ORION' });
    await userEvent.type(box, 'a follow-up');
    act(() => screen.getByText('show').click());
    expect(box).toHaveFocus();
    expect(h.announce).toHaveBeenCalledWith('Waiting for you: save 2 cohorts?');
    await userEvent.keyboard('{Enter}');
    expect(h.onCreate).not.toHaveBeenCalled();
    expect(box).toHaveFocus();
  });
});
