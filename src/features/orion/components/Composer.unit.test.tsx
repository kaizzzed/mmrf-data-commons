import React, { useState } from 'react';
import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createThread, threadReducer, type RunState } from '../agui/reducer';
import { fixtureEvents, renderWithMantine } from '../testing';
import { Composer } from './Composer';
import { composerKeyAction } from './composerKeys';
import { ThreadView } from './ThreadView';

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
    renderWithMantine(<ThreadView runs={[run]} running onStop={onStop} onOpenApp={jest.fn()} />);
    const vizTitle = screen.getByRole('heading', { name: 'Correlation Plot · survival' });
    fireEvent.keyDown(vizTitle, { key: 'Escape' });
    expect(onStop).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole('log', { name: 'Conversation' }), { key: 'Escape' });
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('ignores Esc when no run is active', () => {
    const onStop = jest.fn();
    renderWithMantine(
      <ThreadView runs={[run]} running={false} onStop={onStop} onOpenApp={jest.fn()} />,
    );
    fireEvent.keyDown(screen.getByRole('log', { name: 'Conversation' }), { key: 'Escape' });
    expect(onStop).not.toHaveBeenCalled();
  });
});
