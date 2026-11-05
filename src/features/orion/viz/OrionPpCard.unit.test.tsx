import React, { type ReactElement } from 'react';
import { MantineProvider } from '@mantine/core';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { webcrypto } from 'crypto';
import type { PinnedViz } from '../agui/types';
import { createLiveVizRegistry, LiveVizContext, type LiveVizRegistry } from './liveViz';
import { OrionPpCard } from './OrionPpCard';

interface BindCall {
  rootElem: HTMLElement;
  initArgs: Record<string, unknown>;
  updateArgs?: unknown;
}

const mockApps: { triggerAbort: jest.Mock; destroy: jest.Mock }[] = [];
const mockBind = jest.fn((arg: BindCall) => {
  // Like a ProteinPaint Menu: a body-level div per mount, plus content in the holder.
  const menu = document.createElement('div');
  menu.className = 'sja_menu_div';
  document.body.appendChild(menu);
  arg.rootElem.appendChild(document.createElement('svg'));
  const app = { triggerAbort: jest.fn(), destroy: jest.fn() };
  mockApps.push(app);
  return Promise.resolve(app);
});

jest.mock('@sjcrh/proteinpaint-client', () => ({
  bindProteinPaint: (arg: BindCall) => mockBind(arg),
}));

const survival: PinnedViz = { kind: 'survival', filter0: null, term: 'overall_survival', overlay: 'cgs_risk_category' };

const renderCards = (registry: LiveVizRegistry, ui: ReactElement) =>
  render(
    <MantineProvider>
      <LiveVizContext.Provider value={registry}>{ui}</LiveVizContext.Provider>
    </MantineProvider>,
  );

const card = (vizId: string, pinned: PinnedViz = survival) => (
  <OrionPpCard key={vizId} vizId={vizId} title={`Card ${vizId}`} pinned={pinned} host="/protein-paint" />
);

const menuCount = () => document.querySelectorAll('body > .sja_menu_div').length;
const phaseOf = (vizId: string) => screen.getByTestId(`orion-viz-${vizId}`).getAttribute('data-phase');

beforeAll(() => {
  if (!globalThis.crypto.subtle) {
    Object.defineProperty(globalThis.crypto, 'subtle', { value: webcrypto.subtle });
  }
});

beforeEach(() => {
  mockBind.mockClear();
  mockApps.length = 0;
});

describe('<OrionPpCard />', () => {
  it('binds once with pinned initArgs and no updateArgs, and ignores later props', async () => {
    const registry = createLiveVizRegistry();
    const { rerender } = renderCards(registry, card('a'));
    await waitFor(() => expect(phaseOf('a')).toBe('mounted'));
    expect(mockBind).toHaveBeenCalledTimes(1);
    const [{ rootElem, initArgs, updateArgs }] = mockBind.mock.calls[0];
    expect(updateArgs).toBeUndefined();
    expect(initArgs.holder).toBe(rootElem);
    expect(initArgs).toMatchObject({ launchGdcCorrelation: true, filter0: null, host: '/protein-paint' });

    rerender(
      <MantineProvider>
        <LiveVizContext.Provider value={registry}>
          {card('a', { ...survival, filter0: { and: [] } })}
        </LiveVizContext.Provider>
      </MantineProvider>,
    );
    expect(mockBind).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('orion-viz-a')).toHaveAttribute('data-pinned-hash', expect.stringMatching(/^[0-9a-f]{64}$/));
  });

  it('keeps two live, freezes the oldest, and re-opens it on a fresh root', async () => {
    const registry = createLiveVizRegistry();
    const { rerender } = renderCards(registry, <>{['a', 'b'].map((id) => card(id))}</>);
    await waitFor(() => expect(mockBind).toHaveBeenCalledTimes(2));
    rerender(
      <MantineProvider>
        <LiveVizContext.Provider value={registry}>{['a', 'b', 'c'].map((id) => card(id))}</LiveVizContext.Provider>
      </MantineProvider>,
    );
    await waitFor(() => expect(phaseOf('a')).toBe('frozen'));
    expect(phaseOf('b')).not.toBe('frozen');
    await waitFor(() => expect(mockApps[0].destroy).toHaveBeenCalled());
    expect(mockApps[0].triggerAbort).toHaveBeenCalled();
    expect(mockBind.mock.calls[0][0].rootElem.childNodes).toHaveLength(0);

    await userEvent.click(within(screen.getByTestId('orion-viz-a')).getByRole('button', { name: 'Re-open live' }));
    await waitFor(() => expect(phaseOf('a')).toBe('mounted'));
    expect(phaseOf('b')).toBe('frozen');
    const roots = mockBind.mock.calls.map(([arg]) => arg.rootElem);
    expect(new Set(roots).size).toBe(roots.length);
  });

  it('tears down on unmount: abort, destroy, empty root and its body menus', async () => {
    const before = menuCount();
    const registry = createLiveVizRegistry();
    const { unmount } = renderCards(registry, card('a'));
    await waitFor(() => expect(phaseOf('a')).toBe('mounted'));
    expect(menuCount()).toBe(before + 1);
    await act(async () => unmount());
    await waitFor(() => expect(menuCount()).toBe(before));
    expect(mockApps[0].triggerAbort).toHaveBeenCalled();
    expect(mockApps[0].destroy).toHaveBeenCalled();
    expect(registry.snapshot()).toEqual([]);
  });
});
