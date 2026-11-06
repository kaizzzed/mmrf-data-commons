import React, { useReducer } from 'react';
import { MantineProvider } from '@mantine/core';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createThread, threadReducer, type ThreadState } from '../agui/reducer';
import { tabReducer, type TabState } from '../state/tab';
import { DELETE_THREAD_TITLE, QUOTED_TITLE_CHARS, ThreadList } from './ThreadList';

const id = (c: string) => c.repeat(32);
const [A, B, C, FRESH] = [id('a'), id('b'), id('c'), id('f')];
const IN_PROGRESS = "Can't delete while a run is in progress";
const consequences = (title: string) =>
  `“${title}” will be removed from this tab. This can't be undone. Cohorts you saved and the run records on the server are not affected.`;

/** A thread whose one run asked `question` and finished. */
const finished = (threadId: string, question: string): ThreadState =>
  [
    { type: 'submit', runId: id('1'), question, at: '2026-11-06T12:00:00.000Z' },
    { type: 'RUN_STARTED', threadId, runId: id('1') },
    { type: 'RUN_FINISHED', threadId, runId: id('1'), result: { status: 'Complete', code: null } },
  ].reduce((t, a) => threadReducer(t, a as Parameters<typeof threadReducer>[1]), createThread(threadId));

const tabOf = (...threads: ThreadState[]): TabState => ({
  version: 1,
  activeThreadId: threads[0].threadId,
  threadIds: threads.map((t) => t.threadId),
  threads: Object.fromEntries(threads.map((t) => [t.threadId, t])),
});

type Blocked = (thread: ThreadState) => string | null;

/** The list over a real tab reducer, as the Assistant wires it. */
const Harness = ({ initial, blocked, onDelete }: { initial: TabState; blocked?: Blocked; onDelete: jest.Mock }) => {
  const [tab, dispatch] = useReducer(tabReducer, initial);
  return (
    <ThreadList
      threads={tab.threadIds.map((t) => tab.threads[t])}
      activeThreadId={tab.activeThreadId}
      onSelect={(threadId) => dispatch({ type: 'selectThread', threadId })}
      onNew={() => undefined}
      onDelete={(threadId) => {
        onDelete(threadId);
        dispatch({ type: 'deleteThread', threadId, freshThreadId: FRESH });
      }}
      deleteBlocked={blocked}
    />
  );
};

const setup = (initial: TabState, blocked?: Blocked) => {
  const onDelete = jest.fn();
  const ui = (b?: Blocked) => (
    <MantineProvider>
      <Harness initial={initial} blocked={b} onDelete={onDelete} />
    </MantineProvider>
  );
  const view = render(ui(blocked));
  return { onDelete, rerender: (b?: Blocked) => view.rerender(ui(b)) };
};

const threads = () => screen.getByRole('navigation', { name: 'Threads in this tab' });
const rowTitles = () =>
  within(threads())
    .getAllByRole('listitem')
    .map((li) => within(li).getAllByRole('button')[0].textContent);
const deleteButton = (title: string) => screen.getByRole('button', { name: `Delete thread: ${title}` });
const dialog = () => screen.findByRole('dialog', { name: DELETE_THREAD_TITLE });
const dialogClosed = () => waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

const three = () => tabOf(finished(A, 'first'), finished(B, 'second'), finished(C, 'third'));

describe('<ThreadList /> deleting a thread', () => {
  it('gives each row a delete control named after its thread', () => {
    setup(three());
    expect(rowTitles()).toEqual(['first', 'second', 'third']);
    for (const title of ['first', 'second', 'third']) {
      expect(deleteButton(title)).toBeEnabled();
      expect(deleteButton(title)).toHaveAttribute('type', 'button');
    }
  });

  it('asks first, saying what goes, that it cannot be undone and what stays; Cancel keeps the thread and focus returns', async () => {
    const { onDelete } = setup(three());
    await userEvent.click(deleteButton('second'));
    const confirm = await dialog();
    // The description is the copy alone: the buttons sit outside the dialog's body.
    expect(confirm).toHaveAccessibleDescription(consequences('second'));
    const cancel = within(confirm).getByRole('button', { name: 'Cancel' });
    await waitFor(() => expect(cancel).toHaveFocus());
    expect(within(confirm).getByRole('button', { name: 'Delete' })).toBeEnabled();

    await userEvent.click(cancel);
    await dialogClosed();
    expect(onDelete).not.toHaveBeenCalled();
    expect(rowTitles()).toEqual(['first', 'second', 'third']);
    expect(deleteButton('second')).toHaveFocus();
  });

  it('cancels on Escape', async () => {
    const { onDelete } = setup(three());
    await userEvent.click(deleteButton('third'));
    await dialog();
    await userEvent.keyboard('{Escape}');
    await dialogClosed();
    expect(onDelete).not.toHaveBeenCalled();
    expect(rowTitles()).toEqual(['first', 'second', 'third']);
    expect(deleteButton('third')).toHaveFocus();
  });

  it('deletes on Delete and puts focus on the row of the thread now active', async () => {
    const { onDelete } = setup(three());
    await userEvent.click(deleteButton('first'));
    await userEvent.click(within(await dialog()).getByRole('button', { name: 'Delete' }));
    expect(onDelete).toHaveBeenCalledWith(A);
    await dialogClosed();
    expect(rowTitles()).toEqual(['second', 'third']);
    const active = within(threads()).getByRole('button', { name: 'second' });
    expect(active).toHaveAttribute('aria-current', 'true');
    expect(active).toHaveFocus();
  });

  it('keeps focus on the active row when an inactive thread goes', async () => {
    setup(three());
    await userEvent.click(deleteButton('third'));
    await userEvent.click(within(await dialog()).getByRole('button', { name: 'Delete' }));
    await dialogClosed();
    expect(rowTitles()).toEqual(['first', 'second']);
    expect(within(threads()).getByRole('button', { name: 'first' })).toHaveFocus();
  });

  it('leaves a fresh thread, focused, after the last one goes', async () => {
    setup(tabOf(finished(A, 'only')));
    await userEvent.click(deleteButton('only'));
    await userEvent.click(within(await dialog()).getByRole('button', { name: 'Delete' }));
    await dialogClosed();
    expect(rowTitles()).toEqual(['New thread']);
    const fresh = within(threads()).getByRole('button', { name: 'New thread', current: true });
    expect(fresh).toHaveFocus();
  });

  it('keeps the control of a thread with a run in flight off but focusable, saying why on hover and focus only', async () => {
    const { onDelete } = setup(three(), (t) => (t.threadId === B ? IN_PROGRESS : null));
    const blocked = deleteButton('second');
    // aria-disabled, not disabled: a disabled button takes no hover or focus, so could not say why.
    expect(blocked).toHaveAttribute('aria-disabled', 'true');
    expect(blocked).not.toBeDisabled();
    expect(blocked).toHaveAccessibleDescription(IN_PROGRESS);
    // No line of text under the row (it would read as an order, and shift the rows below).
    const said = within(threads()).getAllByText(IN_PROGRESS);
    expect(said).toHaveLength(1);
    expect(said[0]).toHaveClass('sr-only');
    expect(within(threads()).getAllByRole('listitem').map((li) => li.childElementCount)).toEqual([2, 3, 2]);
    expect(deleteButton('first')).not.toHaveAttribute('aria-disabled');
    expect(deleteButton('first')).not.toHaveAccessibleDescription();
    expect(screen.queryByRole('tooltip')).toBeNull();

    await userEvent.hover(blocked);
    expect(await screen.findByRole('tooltip')).toHaveTextContent(IN_PROGRESS);
    await userEvent.unhover(blocked);
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
    act(() => blocked.focus());
    expect(await screen.findByRole('tooltip')).toHaveTextContent(IN_PROGRESS);

    await userEvent.click(blocked);
    await userEvent.keyboard('{Enter}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('turns Delete off, saying why, when a run starts while the dialog is open', async () => {
    const { onDelete, rerender } = setup(three());
    await userEvent.click(deleteButton('second'));
    const confirm = await dialog();
    rerender((t) => (t.threadId === B ? IN_PROGRESS : null));
    expect(within(confirm).getByRole('button', { name: 'Delete' })).toBeDisabled();
    expect(confirm).toHaveTextContent(IN_PROGRESS);
    expect(confirm).toHaveAccessibleDescription(`${consequences('second')} ${IN_PROGRESS}`);
    await userEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    await dialogClosed();
    expect(onDelete).not.toHaveBeenCalled();
    // Back on the control that opened it, off now, which says why.
    expect(deleteButton('second')).toHaveFocus();
    expect(deleteButton('second')).toHaveAccessibleDescription(IN_PROGRESS);
  });

  it("offers no delete for the tab's only thread while it has no runs: it would only come back the same", () => {
    setup(tabOf(createThread(A)));
    expect(rowTitles()).toEqual(['New thread']);
    expect(screen.queryByRole('button', { name: /^Delete thread/ })).toBeNull();
  });

  it('offers one for an empty thread beside others, and for an only thread that has runs', () => {
    setup(tabOf(createThread(A), finished(B, 'second')));
    expect(deleteButton('New thread')).toBeEnabled();
    expect(deleteButton('second')).toBeEnabled();
  });

  it('quotes a long question cut short, in the control and the dialog, wrapping a long unbroken token', async () => {
    const question = `${'KRAS,NRAS,'.repeat(10)}${'x'.repeat(3900)}`;
    setup(tabOf(finished(A, question), finished(B, 'second')));
    const quoted = `${question.slice(0, QUOTED_TITLE_CHARS - 1)}…`;
    const control = screen.getByRole('button', { name: `Delete thread: ${quoted}` });
    expect(control.getAttribute('aria-label')?.length).toBeLessThan(100);
    await userEvent.click(control);
    const confirm = await dialog();
    expect(confirm).toHaveAccessibleDescription(consequences(quoted));
    const copy = within(confirm).getByText((_, el) => el?.tagName === 'P' && el.textContent === consequences(quoted));
    expect(copy).toHaveClass('[overflow-wrap:anywhere]');
    // The row itself still shows the whole question (truncated on screen by CSS).
    expect(rowTitles()[0]).toBe(question);
  });

  it('uses none of the light gen3 base tokens (#f4f3f1 and the like) for text, in the list or the dialog', async () => {
    setup(three(), (t) => (t.threadId === B ? IN_PROGRESS : null));
    await userEvent.click(deleteButton('first'));
    const confirm = await dialog();
    const light = /(^|\s)(\w+:)*text-base-(lightest|lighter|light|vivid|dark|darker)(\s|$)/;
    for (const root of [threads(), confirm]) {
      const offenders = [root, ...root.querySelectorAll('*')].filter((el) => light.test(el.getAttribute('class') ?? ''));
      expect(offenders).toEqual([]);
    }
  });
});
