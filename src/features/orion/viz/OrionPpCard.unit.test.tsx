import React, { type ReactElement } from 'react';
import { MantineProvider } from '@mantine/core';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PinnedViz } from '../agui/types';
import { createLiveVizRegistry, LiveVizContext, type LiveVizRegistry } from './liveViz';
import { errorText, OrionPpCard, type ViewerOutcome } from './OrionPpCard';

interface BindCall {
  rootElem: HTMLElement;
  initArgs: Record<string, unknown>;
  updateArgs?: unknown;
}

type MockApp = { triggerAbort: jest.Mock; destroy: jest.Mock };
const mockApps: MockApp[] = [];
/** One-off behaviours for the next binds; a plain bind mounts. */
const mockNext: ((arg: BindCall) => Promise<MockApp | undefined>)[] = [];
const mockBind = jest.fn((arg: BindCall) => {
  const next = mockNext.shift();
  if (next) return next(arg);
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

beforeEach(() => {
  mockBind.mockClear();
  mockApps.length = 0;
  mockNext.length = 0;
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

  it.each<[string, (arg: BindCall) => Promise<MockApp | undefined>, string]>([
    ['a rejected bind', () => Promise.reject(new Error('no such chart')), 'no such chart'],
    ['no app (runproteinpaint wrote its error into the holder)', (arg) => {
      arg.rootElem.textContent = 'Error: unknown dslabel';
      return Promise.resolve(undefined);
    }, 'Error: unknown dslabel'],
    ['an error bar in the holder', (arg) => {
      arg.rootElem.innerHTML = '<div class="sja_errorbar"><div>x</div><div>Error: termdb/survival 500</div></div>';
      return Promise.resolve({ triggerAbort: jest.fn(), destroy: jest.fn() });
    }, 'Error: termdb/survival 500'],
  ])('reports a failed session on %s, with the message', async (_label, behaviour, message) => {
    mockNext.push(behaviour);
    const outcomes: ViewerOutcome[] = [];
    renderCards(
      createLiveVizRegistry(),
      <OrionPpCard vizId="a" title="A" pinned={survival} host="/protein-paint" onOutcome={(o) => outcomes.push(o)} />,
    );
    await waitFor(() => expect(phaseOf('a')).toBe('error'));
    expect(screen.getByRole('alert')).toHaveTextContent(message);
    expect(outcomes).toEqual([{ kind: 'failed', ms: expect.any(Number), message }]);
  });

  it('mounts when the holder has only the hidden, empty error bar the mass apps create at start', async () => {
    // Seen live with Correlation Plot 2.216.0: <div class="sja_errorbar" style="display: none;"></div>.
    mockNext.push((arg) => {
      arg.rootElem.innerHTML = '<div class="sja_errorbar" style="display: none;"></div><svg></svg>';
      return Promise.resolve({ triggerAbort: jest.fn(), destroy: jest.fn() });
    });
    const outcomes: ViewerOutcome[] = [];
    renderCards(
      createLiveVizRegistry(),
      <OrionPpCard vizId="a" title="A" pinned={survival} host="/protein-paint" onOutcome={(o) => outcomes.push(o)} />,
    );
    await waitFor(() => expect(phaseOf('a')).toBe('mounted'));
    expect(outcomes).toEqual([{ kind: 'mounted', ms: expect.any(Number) }]);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('reads the shown error bar, skipping hidden ones and bars inside a hidden block', () => {
    const root = document.createElement('div');
    root.innerHTML =
      '<div class="sja_errorbar" style="display: none;"></div>' +
      '<div style="display: none"><div class="sja_errorbar"><div>x</div><div>stale</div></div></div>' +
      '<div class="sja_errorbar"><div>x</div><div>Error: termdb/DE 500</div></div>';
    expect(errorText(root)).toBe('Error: termdb/DE 500');
    root.lastElementChild?.remove();
    expect(errorText(root)).toBeNull();
    root.innerHTML = '<div class="sja_errorbar"></div>';
    expect(errorText(root)).toBe('The viewer reported an error.');
  });

  it('reports one mounted outcome per live session', async () => {
    const outcomes: ViewerOutcome[] = [];
    renderCards(
      createLiveVizRegistry(),
      <OrionPpCard vizId="a" title="A" pinned={survival} host="/protein-paint" onOutcome={(o) => outcomes.push(o)} />,
    );
    await waitFor(() => expect(phaseOf('a')).toBe('mounted'));
    expect(outcomes).toEqual([{ kind: 'mounted', ms: expect.any(Number) }]);
  });

  it('starts one viewer at a time: the next waits until the first has drawn', async () => {
    let finish: (app: MockApp) => void = () => undefined;
    mockNext.push(() => new Promise<MockApp>((resolve) => (finish = resolve)));
    renderCards(createLiveVizRegistry(), <>{['a', 'b'].map((id) => card(id))}</>);
    await waitFor(() => expect(mockBind).toHaveBeenCalledTimes(1));
    expect(phaseOf('a')).toBe('loading');
    expect(phaseOf('b')).toBe('queued');
    expect(screen.getByTestId('orion-viz-b').closest('section')).toHaveTextContent('Waiting to start');
    await act(async () => finish({ triggerAbort: jest.fn(), destroy: jest.fn() }));
    await waitFor(() => expect(phaseOf('b')).toBe('mounted'));
    expect(phaseOf('a')).toBe('mounted');
  });

  it('a blocked card takes no live slot and never binds, so it freezes no other card', async () => {
    const registry = createLiveVizRegistry();
    renderCards(
      registry,
      <>
        {card('a')}
        {card('b')}
        <OrionPpCard
          vizId="c"
          title="C"
          pinned={survival}
          blockedReason="Checking the local data."
          blockedView={<p>Cited table</p>}
        />
      </>,
    );
    await waitFor(() => expect(mockBind).toHaveBeenCalledTimes(2));
    expect(registry.snapshot()).toEqual(['a', 'b']);
    expect(phaseOf('c')).toBe('blocked');
    const blocked = screen.getByTestId('orion-viz-c');
    expect(within(blocked).getByRole('status')).toHaveTextContent('Checking the local data.');
    expect(within(blocked).getByText('Cited table')).toBeInTheDocument();
    expect(within(blocked).queryByRole('button', { name: 'Re-open live' })).not.toBeInTheDocument();
  });

  it('waits for pinned inputs, then reads them once; the registry key may differ from the viz id', async () => {
    const registry = createLiveVizRegistry();
    const ui = (pinned: PinnedViz | null) => (
      <MantineProvider>
        <LiveVizContext.Provider value={registry}>
          <OrionPpCard vizId="v1" liveKey="run-1:v1" title="A" pinned={pinned} host="/protein-paint" />
        </LiveVizContext.Provider>
      </MantineProvider>
    );
    const { rerender } = render(ui(null));
    expect(phaseOf('v1')).toBe('blocked');
    expect(mockBind).not.toHaveBeenCalled();
    rerender(ui(survival));
    await waitFor(() => expect(phaseOf('v1')).toBe('mounted'));
    expect(registry.snapshot()).toEqual(['run-1:v1']);
    rerender(ui({ ...survival, overlay: 'iss_stage' }));
    expect(mockBind).toHaveBeenCalledTimes(1);
    expect(mockBind.mock.calls[0][0].initArgs).toMatchObject({ state: { plots: [{ term2: { id: 'cgs_risk_category' } }] } });
  });

  it('asks OncoMatrix for its postRender event and counts it mounted only then', async () => {
    let rendered: (() => void) | undefined;
    mockNext.push((arg) => {
      const opts = arg.initArgs.opts as { matrix: { callbacks: Record<string, () => void> } };
      rendered = opts.matrix.callbacks['postRender.orion'];
      return Promise.resolve({ triggerAbort: jest.fn(), destroy: jest.fn() });
    });
    const outcomes: ViewerOutcome[] = [];
    renderCards(
      createLiveVizRegistry(),
      <OrionPpCard
        vizId="m"
        title="M"
        pinned={{ kind: 'oncomatrix', filter0: null, genes: ['KRAS'] }}
        host="/protein-paint"
        onOutcome={(o) => outcomes.push(o)}
      />,
    );
    await waitFor(() => expect(rendered).toBeDefined());
    await act(async () => undefined);
    expect(phaseOf('m')).toBe('loading');
    expect(outcomes).toEqual([]);
    await act(async () => rendered?.());
    expect(phaseOf('m')).toBe('mounted');
    expect(outcomes).toEqual([{ kind: 'mounted', ms: expect.any(Number) }]);
  });
});
