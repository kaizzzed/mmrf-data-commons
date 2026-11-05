import React, { useState } from 'react';
import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createThread, threadReducer, type RunState } from '../agui/reducer';
import { fixtureEvents, renderWithMantine } from '../testing';
import { Composer } from './Composer';
import { composerKeyAction } from './composerKeys';
import { ThreadView } from './ThreadView';

jest.mock('../viz/VizCard', () => ({
  VizCard: ({ spec }: { spec: { vizId: string; title: string } }) => (
    <section aria-label={`Viz ${spec.vizId}`}>
      <h3>{spec.title}</h3>
      <button type="button">Viewer menu</button>
    </section>
  ),
}));

const key = (k: string, shiftKey = false, isComposing = false) => ({ key: k, shiftKey, isComposing });

describe('composerKeyAction', () => {
  it.each([
    ['Enter sends', key('Enter'), false, true, 'send'],
    ['Shift+Enter adds a line', key('Enter', true), false, true, 'newline'],
    ['Enter on an empty composer does nothing', key('Enter'), false, false, 'hold'],
    ['Enter while a run is active holds the text', key('Enter'), true, true, 'hold'],
    ['Esc stops an active run', key('Escape'), true, false, 'stop'],
    ['Esc with no run does nothing', key('Escape'), false, true, 'none'],
    ['Enter that confirms an IME composition does nothing', key('Enter', false, true), false, true, 'none'],
    ['other keys pass through', key('a'), false, true, 'none'],
  ] as const)('%s', (_label, event, running, hasText, expected) => {
    expect(composerKeyAction(event, { running, hasText })).toBe(expected);
  });
});

const Harness = ({
  running = false,
  onSend,
  onStop,
}: {
  running?: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
}) => {
  const [value, setValue] = useState('');
  return (
    <Composer
      value={value}
      onChange={setValue}
      onSend={() => onSend(value)}
      onStop={onStop}
      running={running}
      scopeLabel="Scope: All cases · 1,000 cases"
    />
  );
};

describe('<Composer />', () => {
  it('sends on Enter and adds a line on Shift+Enter', async () => {
    const onSend = jest.fn();
    renderWithMantine(<Harness onSend={onSend} onStop={jest.fn()} />);
    const box = screen.getByRole('textbox', { name: 'Ask ORION' });
    await userEvent.type(box, 'first line{Shift>}{Enter}{/Shift}second');
    expect(box).toHaveValue('first line\nsecond');
    expect(onSend).not.toHaveBeenCalled();
    await userEvent.type(box, '{Enter}');
    expect(onSend).toHaveBeenCalledWith('first line\nsecond');
    expect(box).toHaveValue('first line\nsecond');
  });

  it('shows the scope chip and a disabled Send until there is text', () => {
    renderWithMantine(<Harness onSend={jest.fn()} onStop={jest.fn()} />);
    expect(screen.getByText('Scope: All cases · 1,000 cases')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('turns Send into Stop while a run is active; Esc stops and Enter holds the text', async () => {
    const onSend = jest.fn();
    const onStop = jest.fn();
    renderWithMantine(<Harness running onSend={onSend} onStop={onStop} />);
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    const box = screen.getByRole('textbox', { name: 'Ask ORION' });
    await userEvent.type(box, 'next question{Enter}');
    expect(onSend).not.toHaveBeenCalled();
    expect(box).toHaveValue('next question');
    await userEvent.keyboard('{Escape}');
    expect(onStop).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(onStop).toHaveBeenCalledTimes(2);
  });
});

describe('<ThreadView /> Esc', () => {
  const run: RunState = Object.values(
    fixtureEvents().reduce(threadReducer, createThread('4f0c1a9e2b7d4c3e8a6f5b1d0e9c2a7b')).runs,
  )[0];

  it('stops from the thread but never from inside a visualization card', () => {
    const onStop = jest.fn();
    renderWithMantine(<ThreadView runs={[run]} running onStop={onStop} />);
    const viewerControl = within(screen.getByRole('region', { name: 'Viz v1' })).getByRole('button', { name: 'Viewer menu' });
    fireEvent.keyDown(viewerControl, { key: 'Escape' });
    expect(onStop).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole('log', { name: 'Conversation' }), { key: 'Escape' });
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('ignores Esc when no run is active', () => {
    const onStop = jest.fn();
    renderWithMantine(<ThreadView runs={[run]} running={false} onStop={onStop} />);
    fireEvent.keyDown(screen.getByRole('log', { name: 'Conversation' }), { key: 'Escape' });
    expect(onStop).not.toHaveBeenCalled();
  });
});

describe('<Composer /> scope chip', () => {
  const OPTIONS = [
    { cohortId: 'c-all', name: 'Cohort', caseCount: 1000, allCases: true },
    { cohortId: 'c-black', name: 'Black patients', caseCount: 334, allCases: false },
  ];

  it('switches the active cohort from the chip, only on a click', async () => {
    const onSwitchScope = jest.fn();
    renderWithMantine(
      <Composer
        value=""
        onChange={() => undefined}
        onSend={() => undefined}
        onStop={() => undefined}
        running={false}
        scopeLabel="Scope: Black patients · 334 cases"
        scopeOptions={OPTIONS}
        onSwitchScope={onSwitchScope}
      />,
    );
    const chip = screen.getByRole('button', { name: 'Scope: Black patients · 334 cases. Switch scope' });
    expect(chip).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(chip);
    const list = screen.getByRole('list', { name: 'Make a cohort active' });
    expect(within(list).getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Cohort (all cases) · 1,000 cases',
      'Black patients · 334 cases',
    ]);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('list', { name: 'Make a cohort active' })).toBeNull();
    expect(onSwitchScope).not.toHaveBeenCalled();
    await userEvent.click(chip);
    await userEvent.click(screen.getByRole('button', { name: 'Cohort (all cases) · 1,000 cases' }));
    expect(onSwitchScope).toHaveBeenCalledWith(OPTIONS[0]);
    // The text box is described by the scope it will ask about.
    expect(screen.getByRole('textbox', { name: 'Ask ORION' })).toHaveAccessibleDescription('Scope for this question: Black patients · 334 cases');
  });

  it('shows Stopping, and waits, once Stop was pressed', async () => {
    const onStop = jest.fn();
    renderWithMantine(
      <Composer value="" onChange={() => undefined} onSend={() => undefined} onStop={onStop} running stopping scopeLabel="Scope: All cases · 1,000 cases" />,
    );
    expect(screen.getByRole('button', { name: 'Stopping' })).toBeDisabled();
    await userEvent.type(screen.getByRole('textbox', { name: 'Ask ORION' }), '{Escape}');
    expect(onStop).not.toHaveBeenCalled();
  });
});
