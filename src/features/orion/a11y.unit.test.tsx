// Accessibility of the thread (F2 "Accessibility and layout", C-17, E21): axe-core over every
// fixture state as the Assistant renders it, the heading outline, no default button anywhere, and
// focus when a card that waits on the researcher appears, for each such card.

import React, { StrictMode } from 'react';
import { MantineProvider } from '@mantine/core';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { render } from 'test-utils';
import { fixtureTransport, type RunTransport } from './agui/transport';
import type { RunAgentInput } from './agui/types';
import AssistantApp from './AssistantApp';
import { memoryLedgerStore } from './cohort/saveLedger';
import { createWriteLog } from './cohort/writeLog';
import { RunItem } from './components/RunItem';
import {
  createTestCohortStore,
  mockActions,
  recordingNotifier,
  renderWithActions,
  replayStream,
  STREAM_NAMES,
  streamRunId,
  streamText,
  type StreamName,
} from './testing';

jest.mock('@sjcrh/proteinpaint-client', () => ({
  bindProteinPaint: ({ rootElem }: { rootElem: HTMLElement }) => {
    rootElem.appendChild(document.createElement('svg'));
    return Promise.resolve({ triggerAbort: jest.fn(), destroy: jest.fn() });
  },
}));

/** axe-core's WCAG A and AA rules; the ones that need layout or a whole page are left to the browser. */
const axeViolations = async (root: Element) => {
  const results = await axe.run(root, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] },
    rules: {
      // jsdom has no layout or colours.
      'color-contrast': { enabled: false },
      // A fragment of a page: its landmarks and its one h1 are the platform's.
      region: { enabled: false },
      'page-has-heading-one': { enabled: false },
      'landmark-one-main': { enabled: false },
    },
  });
  return results.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.html.slice(0, 160)) }));
};

/** The heading levels in document order; a level never skips one on the way down. */
const headingLevels = (root: Element): number[] =>
  Array.from(root.querySelectorAll('h1, h2, h3, h4, h5, h6')).map((h) => Number(h.tagName[1]));

const skipsALevel = (levels: number[], start: number): boolean =>
  levels.some((level, i) => level > (i === 0 ? start : levels[i - 1]) + 1);

/** A Form or a submit button would make Enter answer a card (C-17); none exists. */
const defaultButtons = (root: Element): string[] => [
  ...Array.from(root.querySelectorAll('form')).map(() => 'form'),
  ...Array.from(root.querySelectorAll('button')).filter((b) => b.getAttribute('type') !== 'button').map((b) => b.outerHTML.slice(0, 120)),
  ...Array.from(root.querySelectorAll('input[type="submit"], input[type="image"]')).map((i) => i.outerHTML),
];

describe('the axe check itself', () => {
  it('finds what it should, so a pass below means something', async () => {
    const page = document.createElement('div');
    page.innerHTML = '<h3>Card</h3><h5>Skipped a level</h5><button type="button"></button><img src="x.png">';
    document.body.appendChild(page);
    try {
      expect((await axeViolations(page)).map((v) => v.id).sort()).toEqual(['button-name', 'heading-order', 'image-alt']);
      expect(skipsALevel(headingLevels(page), 2)).toBe(true);
    } finally {
      page.remove();
    }
  });
});

describe('every fixture state, as the thread renders it', () => {
  it.each(STREAM_NAMES)('%s: no axe violation, an unbroken heading outline, no default button', async (name: StreamName) => {
    const thread = replayStream(name);
    const run = thread.runs[streamRunId(name)];
    const { container } = renderWithActions(<RunItem run={run} />, mockActions({ latestRunId: run.runId }));
    // Let the viz cards settle (pinned inputs, parity, the mocked viewer).
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(await axeViolations(container)).toEqual([]);
    // Cards are h3 under the Assistant's h2; their parts are h4.
    const levels = headingLevels(container);
    expect(levels.length).toBeGreaterThan(0);
    expect(Math.min(...levels)).toBe(3);
    expect(skipsALevel(levels, 2)).toBe(false);
    expect(defaultButtons(container)).toEqual([]);
    // Every card is a region named by its heading.
    for (const region of within(container).queryAllByRole('region')) {
      expect(region).toHaveAccessibleName();
    }
  });
});

// ------------------------------------------------------------------ the whole Assistant

/** The fixture replay with an answer per action, recording each turn. */
const replay = (ask: StreamName, replies: FixtureReplies = {}) => {
  const inner = fixtureTransport({ delayMs: 0, stream: streamText(ask), replies });
  const turns: RunAgentInput[] = [];
  const transport: RunTransport = {
    replay: true,
    run: (input, signal) => {
      turns.push(input);
      return inner.run(input, signal);
    },
  };
  return { transport, turns };
};
type FixtureReplies = NonNullable<Parameters<typeof fixtureTransport>[0]>['replies'];

const renderApp = (transport: RunTransport) => {
  const cohorts = createTestCohortStore([{ id: 'c-all', name: 'Cohort' }]);
  return render(
    <StrictMode>
      <MantineProvider>
        <AssistantApp
          transport={transport}
          cohorts={cohorts.port}
          ledger={memoryLedgerStore()}
          log={createWriteLog(() => undefined)}
          notifier={recordingNotifier()}
          openApp={jest.fn()}
        />
      </MantineProvider>
    </StrictMode>,
  );
};

const composer = () => screen.getByRole('textbox', { name: 'Ask ORION' });
const actionsOf = (turns: RunAgentInput[]) => turns.map((t) => t.forwardedProps.orion.action);

beforeEach(() => {
  window.sessionStorage.clear();
  window.history.replaceState({}, '', '/');
});

describe('the Assistant page', () => {
  it('first use, a finished answer and the open Evidence Inspector: no axe violation, h2 then h3 and h4', async () => {
    const { container } = renderApp(replay('j1-complete').transport);
    expect(await axeViolations(container)).toEqual([]);
    await userEvent.type(composer(), 'J1{Enter}');
    const answer = await screen.findByRole('region', { name: 'Answer' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument());
    expect(await axeViolations(container)).toEqual([]);
    expect(headingLevels(container)[0]).toBe(2);
    expect(skipsALevel(headingLevels(container), 1)).toBe(false);
    expect(defaultButtons(container)).toEqual([]);

    await userEvent.click(within(answer).getAllByRole('button', { name: 'Row 1 · s2 cohort_count' })[0]);
    const inspector = screen.getByRole('complementary', { name: 'Evidence Inspector' });
    expect(within(inspector).getByRole('heading', { level: 2, name: 'Evidence Inspector' })).toHaveFocus();
    expect(await axeViolations(container)).toEqual([]);
    expect(skipsALevel(headingLevels(inspector), 1)).toBe(false);
  });

  it.each([
    ['clarify', 'Which classification defines high risk?', 'CGS risk category: High risk, Standard risk'],
    ['consent', 'Use Correlation Plot instead of OncoMatrix?', 'Use Correlation Plot'],
    ['j3-save-pause', 'Save 2 cohorts', 'Create'],
  ] as const)('%s: the card takes focus on its heading when it appears, never on a button', async (stream, title, button) => {
    const { transport } = replay(stream);
    const { container } = renderApp(transport);
    await userEvent.type(composer(), 'a question{Enter}');
    const heading = await screen.findByRole('heading', { level: 3, name: title });
    await waitFor(() => expect(heading).toHaveFocus());
    const card = screen.getByRole('region', { name: title });
    await waitFor(() => expect(within(card).getByRole('button', { name: button })).toBeEnabled());
    expect(heading).toHaveFocus();
    expect(await axeViolations(container)).toEqual([]);
    expect(defaultButtons(container)).toEqual([]);
  });

  it.each([
    ['clarify', 'Which classification defines high risk?', 'clarify_answer'],
    ['consent', 'Use Correlation Plot instead of OncoMatrix?', 'consent'],
    ['j3-save-pause', 'Save 2 cohorts', 'confirm'],
  ] as const)(
    'E21 %s: text typed while the run streams keeps focus as the card appears, and Enter never answers it',
    async (stream, title, action) => {
      const { transport, turns } = replay(stream);
      renderApp(transport);
      await userEvent.type(composer(), 'first question{Enter}');
      await userEvent.type(composer(), 'and another');
      const heading = await screen.findByRole('heading', { level: 3, name: title });
      await screen.findByRole('button', { name: 'Send' });
      expect(composer()).toHaveFocus();
      expect(heading).not.toHaveFocus();
      // The prompt takes focus as it appears, so the key press is awaited as one act.
      await act(async () => {
        await userEvent.keyboard('{Enter}');
      });
      // A new question at a pause asks first; the card's action was never sent.
      expect(screen.getByRole('heading', { name: 'Cancel the waiting run and send this, or keep it waiting?' })).toHaveFocus();
      expect(actionsOf(turns)).not.toContain(action);
      await userEvent.click(screen.getByRole('button', { name: 'Keep it waiting' }));
      expect(composer()).toHaveValue('and another');
      expect(composer()).toHaveFocus();
      expect(actionsOf(turns)).toEqual(['warmup', 'ask']);
    },
  );
});
