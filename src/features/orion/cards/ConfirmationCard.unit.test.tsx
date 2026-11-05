import React, { useState } from 'react';
import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ConfirmPending, RunView } from '../agui/types';
import { Composer } from '../components/Composer';
import { renderWithMantine, streamViews } from '../testing';
import { ConfirmationCard, type ConfirmationCardProps } from './ConfirmationCard';

const PAUSE = streamViews('j3-save-pause').pop() as RunView;
const PENDING = PAUSE.pending as ConfirmPending;

const handlers = () => ({
  onCreate: jest.fn(),
  onRename: jest.fn(),
  onDontSave: jest.fn(),
  onCite: jest.fn(),
});

const renderCard = (props: Partial<ConfirmationCardProps> = {}) => {
  const h = handlers();
  const result = renderWithMantine(
    <ConfirmationCard pending={PENDING} facts={PAUSE.facts} composerHasText={false} {...h} {...props} />,
  );
  return { ...h, ...result };
};

const card = () => screen.getByRole('region', { name: 'Save 2 cohorts' });

describe('<ConfirmationCard />', () => {
  it('moves focus to its heading when it appears, never to Create', () => {
    renderCard();
    expect(screen.getByRole('heading', { name: 'Save 2 cohorts' })).toHaveFocus();
    expect(screen.getByText('Waiting for you')).toBeInTheDocument();
    expect(within(card()).getByRole('button', { name: 'Create' })).not.toHaveFocus();
  });

  it('has plain buttons only: no form, no default, no submit, no autofocus', () => {
    const { container } = renderCard();
    expect(container.querySelector('form')).toBeNull();
    expect(container.querySelector('[autofocus], [data-autofocus]')).toBeNull();
    for (const button of within(card()).getAllByRole('button')) {
      expect(button).toHaveAttribute('type', 'button');
    }
  });

  it('shows each name, definition, case and eligible count as chips, control first', () => {
    const { onCite } = renderCard();
    const names = within(card()).getAllByRole('heading', { level: 4 }).map((h) => h.textContent);
    expect(names).toEqual(['KRAS not detected (ORION)', 'KRAS mutated (ORION)']);
    expect(within(card()).getByText('Mutation-tested cases without a KRAS mutation, as a case-ID list')).toBeInTheDocument();
    const counts = within(card()).getAllByText(/RNA-seq eligible$/).map((el) => el.textContent);
    expect(counts).toEqual([
      '520Row 3 · s5 set_operation cases · 520Row 4 · s7 de_preanalysis RNA-seq eligible',
      '480Row 1 · s2 gene_cases cases · 480Row 4 · s7 de_preanalysis RNA-seq eligible',
    ]);
    within(card()).getByRole('button', { name: 'Row 1 · s2 gene_cases' }).click();
    expect(onCite).toHaveBeenCalledWith('f.s2.count');
  });

  it('says "Already saved as" for a cohort the agent matched', () => {
    const reused: ConfirmPending = {
      ...PENDING,
      cohorts: [{ ...PENDING.cohorts[0], reuse: { cohortId: 'c-1', name: 'KRAS wild type' } }, PENDING.cohorts[1]],
    };
    renderCard({ pending: reused });
    expect(screen.getByText('Already saved as KRAS wild type')).toBeInTheDocument();
  });

  it('lets at most one cohort be made active and passes it to Create; Don\'t save sends nothing ticked', async () => {
    const { onCreate, onDontSave } = renderCard();
    const boxes = within(card()).getAllByRole('checkbox');
    for (const box of boxes) expect(box).not.toBeChecked();
    await userEvent.click(within(card()).getByRole('checkbox', { name: /Make KRAS not detected/ }));
    await userEvent.click(within(card()).getByRole('checkbox', { name: /Make KRAS mutated/ }));
    expect(boxes.filter((b) => (b as HTMLInputElement).checked)).toHaveLength(1);
    await userEvent.click(within(card()).getByRole('button', { name: 'Create' }));
    expect(onCreate).toHaveBeenCalledWith('kras_mut');
    await userEvent.click(within(card()).getByRole('button', { name: "Don't save" }));
    expect(onDontSave).toHaveBeenCalledTimes(1);
  });

  it('renames a cohort only from its own button; Enter in the name field does nothing', async () => {
    const { onRename, onCreate } = renderCard();
    await userEvent.click(within(card()).getByRole('button', { name: 'Rename KRAS not detected (ORION)' }));
    const field = within(card()).getByRole('textbox', { name: 'New name for KRAS not detected (ORION)' });
    await userEvent.clear(field);
    await userEvent.type(field, 'KRAS wild-type (ORION){Enter}');
    expect(onRename).not.toHaveBeenCalled();
    expect(onCreate).not.toHaveBeenCalled();
    await userEvent.click(within(card()).getByRole('button', { name: 'Use this name' }));
    expect(onRename).toHaveBeenCalledWith('kras_wt', 'KRAS wild-type (ORION)');
    expect(within(card()).queryByRole('textbox')).toBeNull();
  });

  it('offers no rename on a run that is not the latest', () => {
    renderCard({ canRename: false });
    expect(within(card()).getByRole('button', { name: 'Rename KRAS mutated (ORION)' })).toBeDisabled();
  });

  it('shows how far an earlier Create got and offers to finish (E19)', () => {
    renderCard({ progress: { saved: 1, total: 2 } });
    expect(within(card()).getByRole('status')).toHaveTextContent('1 of 2 saved');
    expect(within(card()).getByRole('button', { name: 'Finish saving' })).toBeEnabled();
    expect(within(card()).queryByRole('button', { name: 'Create' })).toBeNull();
  });

  it('waits while saving or a turn is in flight, and shows why a Create did not finish', () => {
    renderCard({ busy: true, error: 'Saving stopped: the store refused it' });
    expect(within(card()).getByRole('button', { name: 'Create' })).toBeDisabled();
    expect(within(card()).getByRole('button', { name: "Don't save" })).toBeDisabled();
    expect(within(card()).getByRole('alert')).toHaveTextContent('Saving stopped: the store refused it');
  });

  it('E21: with text in the composer, focus stays there and Enter never saves (C-17)', async () => {
    const h = handlers();
    const onSend = jest.fn();
    const Page = () => {
      const [value, setValue] = useState('');
      const [shown, setShown] = useState(false);
      return (
        <>
          <Composer
            value={value}
            onChange={setValue}
            onSend={onSend}
            onStop={() => undefined}
            running={false}
            scopeLabel="Scope: All cases · 1,000 cases"
          />
          <button type="button" onClick={() => setShown(true)} hidden>
            show
          </button>
          {shown && (
            <ConfirmationCard pending={PENDING} facts={PAUSE.facts} composerHasText={() => value.trim() !== ''} {...h} />
          )}
        </>
      );
    };
    renderWithMantine(<Page />);
    const box = screen.getByRole('textbox', { name: 'Ask ORION' });
    await userEvent.type(box, 'a follow-up');
    act(() => screen.getByText('show').click());
    expect(box).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(h.onCreate).not.toHaveBeenCalled();
    expect(h.onDontSave).not.toHaveBeenCalled();
    expect(box).toHaveFocus();
  });

  it('E21: with an empty composer, Enter on the focused heading saves nothing either', async () => {
    const { onCreate } = renderCard();
    expect(screen.getByRole('heading', { name: 'Save 2 cohorts' })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard(' ');
    expect(onCreate).not.toHaveBeenCalled();
  });
});
