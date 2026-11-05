import React, { type ReactElement } from 'react';
import { MantineProvider } from '@mantine/core';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { webcrypto } from 'crypto';
import type { RunView, VizReport, VizSpec } from '../agui/types';
import { createLiveVizRegistry, LiveVizContext, type LiveVizRegistry } from './liveViz';
import { pinnedHash } from './ppPinnedArgs';
import { deInputPinned, lastView, onlySpec, savedDeRunRequest } from './testing';
import { DE_INPUT_CAPTION, DE_SORT_CAPTION, VizCard, type VizCardProps } from './VizCard';
import { type CitedCall, type VizServices, VizServicesContext } from './vizServices';

interface BindCall {
  rootElem: HTMLElement;
  initArgs: {
    holder: HTMLElement;
    opts?: { matrix?: { callbacks: Record<string, () => void> } };
    state?: { plots: { chartType: string }[] };
    [key: string]: unknown;
  };
}
type Behaviour = (arg: BindCall) => Promise<{ triggerAbort: jest.Mock; destroy: jest.Mock } | undefined>;

const app = () => ({ triggerAbort: jest.fn(), destroy: jest.fn() });

/** Like a working viewer: content in the holder, and OncoMatrix's matrix postRender event. */
const mounts: Behaviour = (arg) => {
  arg.rootElem.appendChild(document.createElement('svg'));
  const rendered = arg.initArgs.opts?.matrix?.callbacks['postRender.orion'];
  if (rendered) setTimeout(rendered, 0);
  return Promise.resolve(app());
};
const rejects =
  (message: string): Behaviour =>
  () =>
    Promise.reject(new Error(message));
/** runproteinpaint's way of failing: a sayerror() bar in the holder, and an app anyway. */
const errorBar =
  (message: string): Behaviour =>
  (arg) => {
    const bar = document.createElement('div');
    bar.className = 'sja_errorbar';
    bar.innerHTML = `<div>✕</div><div>${message}</div>`;
    arg.rootElem.appendChild(bar);
    return Promise.resolve(app());
  };
const neverDraws: Behaviour = () => Promise.resolve(app());

const mockBehaviours: Behaviour[] = [];
const mockBind = jest.fn((arg: BindCall) => (mockBehaviours.shift() ?? mounts)(arg));

jest.mock('@sjcrh/proteinpaint-client', () => ({
  bindProteinPaint: (arg: BindCall) => mockBind(arg),
}));

const subtle = (globalThis.crypto?.subtle ?? webcrypto.subtle) as SubtleCrypto;
const FINGERPRINT = '0f27e0bdbb28a9357689a6137a8db7a9419dc59e5ec6a2a0e09b826bade7d71d';

const services = (patch: Partial<VizServices> = {}): VizServices => ({
  host: '/protein-paint',
  localFingerprint: jest.fn(() => Promise.resolve(FINGERPRINT)),
  loadCitedCall: jest.fn(() => Promise.resolve(null)),
  mountTimeoutMs: 60_000,
  ...patch,
});

interface CardSetup {
  view: RunView;
  spec?: VizSpec;
  onReport?: jest.Mock;
  onOpenInTool?: jest.Mock;
  loadUntrimmedSpec?: jest.Mock;
}

const props = ({ view, spec, onReport, onOpenInTool, loadUntrimmedSpec }: CardSetup): VizCardProps => ({
  threadId: view.threadId,
  run: view,
  spec: spec ?? onlySpec(view),
  onReport: onReport ?? jest.fn(),
  onOpenInTool: onOpenInTool ?? jest.fn(),
  loadUntrimmedSpec: loadUntrimmedSpec ?? jest.fn(() => Promise.resolve(null)),
});

const wrap = (ui: ReactElement, s: VizServices, registry: LiveVizRegistry) => (
  <MantineProvider>
    <LiveVizContext.Provider value={registry}>
      <VizServicesContext.Provider value={s}>{ui}</VizServicesContext.Provider>
    </LiveVizContext.Provider>
  </MantineProvider>
);

const renderCards = (cards: VizCardProps[], s: VizServices = services(), registry = createLiveVizRegistry()) =>
  render(
    wrap(
      <>
        {cards.map((p) => (
          <VizCard key={`${p.run.runId}:${p.spec.vizId}`} {...p} />
        ))}
      </>,
      s,
      registry,
    ),
  );

const card = (vizId = 'v1') => screen.getByTestId(`orion-viz-card-${vizId}`);
const phase = (root: HTMLElement) => within(root).getByTestId(/^orion-viz-v\d+$/).getAttribute('data-phase');
const parityOf = (root: HTMLElement) => within(root).getByTestId('orion-viz-parity');
const launcherOf = (call: BindCall) =>
  ['launchGdcCorrelation', 'launchGdcMatrix', 'launchGdcDE'].find((key) => key in call.initArgs);

const report = (view: RunView, patch: Partial<VizReport> = {}): VizReport => ({
  runId: view.runId,
  vizId: 'v1',
  mounted: true,
  error: null,
  pinnedHashVerified: true,
  ...patch,
});

/** Distinct run ids, so several fixture runs can share one page. */
const asRun = (view: RunView, runId: string): RunView => ({ ...view, runId });

beforeAll(() => {
  if (!globalThis.crypto.subtle) Object.defineProperty(globalThis.crypto, 'subtle', { value: webcrypto.subtle });
});

beforeEach(() => {
  mockBind.mockClear();
  mockBehaviours.length = 0;
});

describe('<VizCard /> mounts every launcher through OrionPpCard', () => {
  it('survival (J1): pinned Correlation launcher, title, footnote caption, parity match, mounted report', async () => {
    const view = lastView('j1-complete');
    const onReport = jest.fn();
    renderCards([props({ view, onReport })]);
    expect(screen.getByRole('heading', { name: 'Overall survival by CGS risk category' })).toBeInTheDocument();
    await waitFor(() => expect(phase(card())).toBe('mounted'));
    const [call] = mockBind.mock.calls.map(([arg]) => arg);
    expect(launcherOf(call)).toBe('launchGdcCorrelation');
    expect(call.initArgs).toMatchObject({ filter0: null, state: { plots: [{ chartType: 'survival' }] } });
    expect(within(card()).getByText(onlySpec(view).caption ?? '')).toBeInTheDocument();
    expect(parityOf(card())).toHaveAttribute('data-parity', 'match');
    expect(parityOf(card())).toHaveTextContent('Parity: matches s4 survival_compare');
    expect(within(card()).getByTestId('orion-viz-pinned-to')).toHaveTextContent('Pinned to All cases · cites s4');
    await waitFor(() => expect(onReport).toHaveBeenCalledWith(report(view)));
    expect(onReport).toHaveBeenCalledTimes(1);
  });

  it('OncoMatrix: pinned genes, and mounted only once the matrix has drawn', async () => {
    const view = lastView('oncomatrix');
    const onReport = jest.fn();
    renderCards([props({ view, onReport })]);
    await waitFor(() => expect(mockBind).toHaveBeenCalledTimes(1));
    const [call] = mockBind.mock.calls.map(([arg]) => arg);
    expect(launcherOf(call)).toBe('launchGdcMatrix');
    expect(call.initArgs.genes).toEqual(['KRAS', 'NRAS', 'DIS3']);
    expect(call.initArgs.opts?.matrix?.callbacks).toHaveProperty(['postRender.orion']);
    await waitFor(() => expect(phase(card())).toBe('mounted'));
    await waitFor(() => expect(onReport).toHaveBeenCalledWith(report(view)));
  });

  it('OncoMatrix that never draws fails at the mount timeout and falls back to its cited table', async () => {
    const view = lastView('oncomatrix');
    const onReport = jest.fn();
    mockBehaviours.push(neverDraws);
    renderCards([props({ view, onReport })], services({ mountTimeoutMs: 30 }));
    await waitFor(() => expect(card()).toHaveAttribute('data-stage', 'static'));
    expect(onReport).toHaveBeenCalledWith(
      report(view, { mounted: false, error: 'The viewer did not finish drawing within 30 ms.' }),
    );
    expect(within(card()).getByRole('table', { name: /Cited output/ })).toBeInTheDocument();
    expect(within(card()).getByRole('status')).toHaveTextContent(/The viewer failed .* Showing the cited output\./);
  });

  it('direct DE (J3): the differentialAnalysis plot, the DE sort caption and the saved groups', async () => {
    const view = lastView('j3-after-confirm');
    const onReport = jest.fn();
    renderCards([props({ view, onReport })]);
    await waitFor(() => expect(phase(card())).toBe('mounted'));
    const [call] = mockBind.mock.calls.map(([arg]) => arg);
    expect(launcherOf(call)).toBe('launchGdcDE');
    expect(call.initArgs.state?.plots[0].chartType).toBe('differentialAnalysis');
    expect(within(card()).getByText(DE_SORT_CAPTION)).toBeInTheDocument();
    expect(parityOf(card())).toHaveTextContent('Parity: matches s9 de_run');
    expect(within(card()).getByTestId('orion-viz-pinned-to')).toHaveTextContent(
      'Pinned to KRAS not detected (ORION) and KRAS mutated (ORION) · cites s9, s10',
    );
    await waitFor(() => expect(onReport).toHaveBeenCalledWith(report(view)));
  });

  it('keeps the DE sort caption on a direct DE card even when the spec carries none (Open question 9)', async () => {
    const view = lastView('j3-after-confirm');
    renderCards([props({ view, spec: { ...onlySpec(view), caption: null } })]);
    await waitFor(() => expect(phase(card())).toBe('mounted'));
    expect(within(card()).getByText(DE_SORT_CAPTION)).toBeInTheDocument();
  });

  it('DEinput (trimmed): shows title, caption and table at once, loads the spec, then mounts DEinput', async () => {
    const view = lastView('j3-deinput');
    const spec = onlySpec(view);
    expect(spec.pinned).toBeNull();
    const pinned = deInputPinned(lastView('j3-after-confirm'));
    // The rebuilt inputs are exactly the agent's: the snapshot's own pinnedHash.
    expect(await pinnedHash(pinned, subtle)).toBe(spec.pinnedHash);
    let resolve: (s: VizSpec) => void = () => undefined;
    const loadUntrimmedSpec = jest.fn(() => new Promise<VizSpec>((r) => (resolve = r)));
    const onReport = jest.fn();
    renderCards([props({ view, loadUntrimmedSpec, onReport })]);

    expect(loadUntrimmedSpec).toHaveBeenCalledWith(view.runId, 'v1');
    expect(screen.getByRole('heading', { name: spec.title })).toBeInTheDocument();
    expect(within(card()).getByText(DE_INPUT_CAPTION)).toBeInTheDocument();
    expect(within(card()).getByRole('table', { name: /Cited output/ })).toBeInTheDocument();
    expect(within(card()).getByRole('status')).toHaveTextContent('Loading the pinned inputs from the run.');
    expect(parityOf(card())).toHaveAttribute('data-parity', 'checking');
    expect(mockBind).not.toHaveBeenCalled();

    await act(async () => resolve({ ...spec, pinned }));
    await waitFor(() => expect(phase(card())).toBe('mounted'));
    const [call] = mockBind.mock.calls.map(([arg]) => arg);
    expect(call.initArgs.state?.plots[0]).toMatchObject({ chartType: 'DEinput', autoSubmit: true });
    expect(parityOf(card())).toHaveAttribute('data-parity', 'match');
    await waitFor(() => expect(onReport).toHaveBeenCalledWith(report(view)));
  });
});

describe('<VizCard /> trimmed pinned inputs', () => {
  it('falls back to the cited table when the view route has no pinned inputs, and reports it unmounted', async () => {
    const view = lastView('j3-deinput');
    const onReport = jest.fn();
    const loadUntrimmedSpec = jest.fn(() => Promise.resolve(null));
    renderCards([props({ view, loadUntrimmedSpec, onReport })]);
    await waitFor(() => expect(card()).toHaveAttribute('data-stage', 'static'));
    expect(parityOf(card())).toHaveAttribute('data-parity', 'unchecked');
    expect(within(card()).getByRole('status')).toHaveTextContent(/pinned inputs could not be loaded/);
    expect(mockBind).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(onReport).toHaveBeenCalledWith(
        report(view, {
          mounted: false,
          error: 'Pinned inputs unavailable: the run’s view has no pinned inputs for this card',
          pinnedHashVerified: null,
        }),
      ),
    );
  });

  it('retries the load from "Try the live viewer again"', async () => {
    const view = lastView('j3-deinput');
    const pinned = deInputPinned(lastView('j3-after-confirm'));
    const loadUntrimmedSpec = jest
      .fn()
      .mockRejectedValueOnce(new Error('view route 503'))
      .mockResolvedValueOnce({ ...onlySpec(view), pinned });
    renderCards([props({ view, loadUntrimmedSpec })]);
    await waitFor(() => expect(card()).toHaveAttribute('data-stage', 'static'));
    expect(within(card()).getByRole('status')).toHaveTextContent('view route 503');
    await userEvent.click(within(card()).getByRole('button', { name: 'Try the live viewer again' }));
    await waitFor(() => expect(phase(card())).toBe('mounted'));
    expect(loadUntrimmedSpec).toHaveBeenCalledTimes(2);
  });

  it('refuses a loaded spec for another launcher', async () => {
    const view = lastView('j3-deinput');
    const other = onlySpec(lastView('j1-complete'));
    renderCards([props({ view, loadUntrimmedSpec: jest.fn(() => Promise.resolve({ ...other, vizId: 'v1' })) })]);
    await waitFor(() => expect(card()).toHaveAttribute('data-stage', 'static'));
    expect(mockBind).not.toHaveBeenCalled();
  });
});

describe('<VizCard /> parity badge (C-21)', () => {
  it('says the chart would not reproduce the cited request, and reports it unverified', async () => {
    const view = lastView('j1-complete');
    const onReport = jest.fn();
    const spec = { ...onlySpec(view), requestPinnedHash: 'f'.repeat(64) };
    renderCards([props({ view, spec, onReport })]);
    await waitFor(() => expect(parityOf(card())).toHaveAttribute('data-parity', 'requestDiffers'));
    expect(parityOf(card())).toHaveTextContent('Parity: differs from s4 survival_compare');
    expect(parityOf(card())).toHaveTextContent(/would not reproduce the cited request/);
    await waitFor(() => expect(onReport).toHaveBeenCalledWith(report(view, { pinnedHashVerified: false })));
  });

  it('flags pinned inputs that do not hash to pinnedHash', async () => {
    const view = lastView('j1-complete');
    const spec = { ...onlySpec(view), pinnedHash: 'e'.repeat(64) };
    renderCards([props({ view, spec })]);
    await waitFor(() => expect(parityOf(card())).toHaveAttribute('data-parity', 'pinnedDiffers'));
    expect(parityOf(card())).toHaveTextContent('Parity: pinned inputs changed');
  });
});

describe('<VizCard /> live cards', () => {
  it('keeps the two newest live and freezes the third-newest to its cited table, without the caption', async () => {
    const j1 = asRun(lastView('j1-complete'), 'a'.repeat(32));
    const onco = asRun(lastView('oncomatrix'), 'b'.repeat(32));
    const de = asRun(lastView('j3-after-confirm'), 'c'.repeat(32));
    const onReport = jest.fn();
    renderCards([props({ view: j1, onReport }), props({ view: onco, onReport }), props({ view: de, onReport })]);
    const [first, second, third] = screen.getAllByTestId('orion-viz-card-v1');
    await waitFor(() => expect(phase(first)).toBe('frozen'));
    await waitFor(() => expect(phase(second)).toBe('mounted'));
    await waitFor(() => expect(phase(third)).toBe('mounted'));
    expect(within(first).getByRole('table', { name: /Cited output/ })).toHaveTextContent('High risk');
    expect(within(first).getByTestId('orion-viz-frozen-note')).toHaveTextContent('Log-rank p = 7.1e-60');
    expect(within(first).queryByText(onlySpec(j1).caption ?? '')).not.toBeInTheDocument();
    expect(within(first).getByRole('button', { name: 'Re-open live' })).toBeInTheDocument();
    // The frozen table keeps every number's chip.
    expect(within(first).getByText('Row 1 · s2 cohort_count')).toBeInTheDocument();

    await userEvent.click(within(first).getByRole('button', { name: 'Re-open live' }));
    await waitFor(() => expect(phase(first)).toBe('mounted'));
    expect(phase(second)).toBe('frozen');
    // A second mount with the same outcome sends no second report.
    expect(onReport.mock.calls.filter(([r]: [VizReport]) => r.runId === j1.runId)).toHaveLength(1);
  });

  it('a card of another run with the same viz id holds its own slot', async () => {
    const one = asRun(lastView('j1-complete'), 'd'.repeat(32));
    const two = asRun(lastView('j1-complete'), 'e'.repeat(32));
    renderCards([props({ view: one }), props({ view: two })]);
    const [a, b] = screen.getAllByTestId('orion-viz-card-v1');
    await waitFor(() => expect(phase(a)).toBe('mounted'));
    await waitFor(() => expect(phase(b)).toBe('mounted'));
  });
});

describe('<VizCard /> fallbacks in the cut order (cut 2)', () => {
  const directFailsThenDeInput = (deInputBehaviour?: Behaviour) => {
    const view = lastView('j3-after-confirm');
    const call: CitedCall = { callId: `${view.runId}.v1.s9.c1`, request: savedDeRunRequest(view), observed: { cacheId: 'k' } };
    const loadCitedCall = jest.fn(() => Promise.resolve(call));
    const onReport = jest.fn();
    mockBehaviours.push(rejects('differentialAnalysis is not a chart type'));
    if (deInputBehaviour) mockBehaviours.push(deInputBehaviour);
    renderCards([props({ view, onReport })], services({ loadCitedCall }));
    return { view, loadCitedCall, onReport };
  };

  it('direct DE fails, then the DEinput fallback mounts on the saved cohorts, seeded from s9’s request', async () => {
    const { view, loadCitedCall, onReport } = directFailsThenDeInput();
    await waitFor(() => expect(card()).toHaveAttribute('data-stage', 'deInput'));
    await waitFor(() => expect(phase(card())).toBe('mounted'));
    expect(loadCitedCall).toHaveBeenCalledWith(view.threadId, view.runId, { planVersion: 1, stepId: 's9' });
    const calls = mockBind.mock.calls.map(([arg]) => arg);
    expect(calls).toHaveLength(2);
    expect(calls[1].initArgs.state?.plots[0]).toMatchObject({ chartType: 'DEinput', autoSubmit: true });
    expect(within(card()).getByTestId('orion-viz-fallback')).toHaveTextContent(
      'Showing the DEinput fallback: the direct DE viewer failed (differentialAnalysis is not a chart type).',
    );
    expect(within(card()).getByText(DE_INPUT_CAPTION)).toBeInTheDocument();
    // The fallback's inputs are the agent's own deInput spec for the same run (j3-deinput).
    expect(await pinnedHash(deInputPinned(view), subtle)).toBe(onlySpec(lastView('j3-deinput')).pinnedHash);
    await waitFor(() =>
      expect(onReport.mock.calls.map(([r]: [VizReport]) => r)).toEqual([
        report(view, { mounted: false, error: 'differentialAnalysis is not a chart type' }),
        report(view, {
          mounted: true,
          error: 'Direct DE viewer failed: differentialAnalysis is not a chart type; the DEinput fallback mounted',
        }),
      ]),
    );
  });

  it('then the static cited table when the DEinput fallback fails too', async () => {
    const { view, onReport } = directFailsThenDeInput(errorBar('No samples in cohort'));
    await waitFor(() => expect(card()).toHaveAttribute('data-stage', 'static'));
    expect(within(card()).getByRole('status')).toHaveTextContent(
      'The direct DE viewer and the DEinput fallback both failed (No samples in cohort). Showing the cited table.',
    );
    expect(within(card()).getByRole('table', { name: /Cited output/ })).toHaveTextContent('BRAF');
    expect(within(card()).getByRole('button', { name: 'Try the live viewer again' })).toBeInTheDocument();
    await waitFor(() =>
      expect(onReport).toHaveBeenLastCalledWith(
        report(view, {
          mounted: false,
          error: 'Direct DE viewer failed: differentialAnalysis is not a chart type; the DEinput fallback failed: No samples in cohort',
        }),
      ),
    );
  });

  it('goes straight to the static table when the record has no de_run call to seed DEinput', async () => {
    const view = lastView('j3-after-confirm');
    mockBehaviours.push(rejects('boom'));
    renderCards([props({ view })], services({ loadCitedCall: jest.fn(() => Promise.resolve(null)) }));
    await waitFor(() => expect(card()).toHaveAttribute('data-stage', 'static'));
    expect(within(card()).getByRole('status')).toHaveTextContent(/no de_run call to seed the DEinput fallback/);
    expect(mockBind).toHaveBeenCalledTimes(1);
  });

  it('a survival viewer that fails shows its cited table, with no DE fallback', async () => {
    const view = lastView('j1-complete');
    const loadCitedCall = jest.fn();
    const onReport = jest.fn();
    mockBehaviours.push(errorBar('Error: termdb/survival 500'));
    renderCards([props({ view, onReport })], services({ loadCitedCall }));
    await waitFor(() => expect(card()).toHaveAttribute('data-stage', 'static'));
    expect(loadCitedCall).not.toHaveBeenCalled();
    expect(within(card()).getByRole('table', { name: /Cited output/ })).toHaveTextContent('Standard risk');
    await waitFor(() =>
      expect(onReport).toHaveBeenCalledWith(report(view, { mounted: false, error: 'Error: termdb/survival 500' })),
    );

    await userEvent.click(within(card()).getByRole('button', { name: 'Try the live viewer again' }));
    await waitFor(() => expect(phase(card())).toBe('mounted'));
    await waitFor(() => expect(onReport).toHaveBeenLastCalledWith(report(view)));
  });
});

describe("<VizCard /> after Don't save (C-16)", () => {
  it('disables hand-off with the WRITE_SKIPPED reason', async () => {
    const view = lastView('j3-dont-save');
    const onOpenInTool = jest.fn();
    renderCards([props({ view, onOpenInTool })]);
    const button = within(card()).getByRole('button', { name: 'Open with this cohort' });
    expect(button).toBeDisabled();
    expect(within(card()).getByTestId('orion-viz-handoff-reason')).toHaveTextContent(
      "You chose Don't save, so no cohort was saved: the chart uses the unsaved groups and Open with this cohort is off.",
    );
    expect(button).toHaveAttribute('aria-describedby', within(card()).getByTestId('orion-viz-handoff-reason').id);
    await userEvent.click(button);
    expect(onOpenInTool).not.toHaveBeenCalled();
  });

  it('disables the DE fallback: a failed direct mount goes straight to the cited table', async () => {
    const view = lastView('j3-dont-save');
    const loadCitedCall = jest.fn();
    mockBehaviours.push(rejects('boom'));
    renderCards([props({ view })], services({ loadCitedCall }));
    await waitFor(() => expect(card()).toHaveAttribute('data-stage', 'static'));
    expect(loadCitedCall).not.toHaveBeenCalled();
    expect(mockBind).toHaveBeenCalledTimes(1);
    expect(within(card()).getByRole('status')).toHaveTextContent(
      "The direct DE viewer failed (boom); You chose Don't save, so the DEinput fallback, which needs saved cohorts, is off. Showing the cited table.",
    );
  });
});

describe('<VizCard /> Expand and Open with this cohort (FR-14)', () => {
  it('widens the card in place to the scroll area it sits in, and back', async () => {
    const view = lastView('j1-complete');
    const { container } = renderCards([props({ view })]);
    const area = document.createElement('div');
    area.style.overflowX = 'auto';
    container.parentElement?.insertBefore(area, container);
    area.appendChild(container);
    const rect = (left: number, width: number) => () => ({ left, width }) as DOMRect;
    jest.spyOn(area, 'getBoundingClientRect').mockImplementation(rect(100, 1300));
    jest.spyOn(container, 'getBoundingClientRect').mockImplementation(rect(400, 700));

    const expand = within(card()).getByRole('button', { name: 'Expand' });
    expect(expand).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(expand);
    expect(card()).toHaveAttribute('data-expanded', 'true');
    expect(card()).toHaveStyle({ marginLeft: '-284px', width: '1268px' });
    expect(within(card()).getByRole('button', { name: 'Collapse' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(within(card()).getByRole('button', { name: 'Collapse' }));
    expect(card()).toHaveAttribute('data-expanded', 'false');
    expect(card().style.marginLeft).toBe('');
  });

  it("opens the card's app on its cohort, and lists the settings to re-apply", async () => {
    const view = lastView('j1-complete');
    const onOpenInTool = jest.fn();
    renderCards([props({ view, onOpenInTool })]);
    await userEvent.click(within(card()).getByRole('button', { name: 'Open with this cohort' }));
    expect(onOpenInTool).toHaveBeenCalledWith('Correlation', null);
    const settings = within(card()).getByTestId('orion-viz-settings');
    expect(settings).toHaveTextContent('In Correlation Plot, set these to match this chart:');
    expect(settings).toHaveTextContent('Overlay: cgs_risk_category');
  });

  it('reads "Make active and open" when the card’s saved cohort is not the active one', async () => {
    const base = lastView('oncomatrix');
    const view: RunView = {
      ...base,
      cohorts: base.cohorts.map((c) => (c.ref === 'high' ? { ...c, save: 'saved', cohortId: 'c-high', savedName: c.name } : c)),
    };
    const onOpenInTool = jest.fn();
    renderCards([props({ view, onOpenInTool })], services({ activeCohortId: 'c-other' }));
    await userEvent.click(within(card()).getByRole('button', { name: 'Make active and open' }));
    expect(onOpenInTool).toHaveBeenCalledWith('OncoMatrix', 'c-high');
  });
});

describe('<VizCard /> mode H fingerprint', () => {
  const modeH = (view: RunView): RunView => ({ ...view, environment: { ...view.environment, mode: 'H' } });

  it('mounts when the local data matches the run', async () => {
    const view = modeH(lastView('j1-complete'));
    const s = services();
    renderCards([props({ view })], s);
    await waitFor(() => expect(phase(card())).toBe('mounted'));
    expect(s.localFingerprint).toHaveBeenCalled();
    expect(within(card()).getByTestId('orion-viz-fingerprint')).toHaveTextContent('Local data: matches the run');
  });

  it('freezes, saying why, when the local data differs, and reports it', async () => {
    const view = modeH(lastView('j1-complete'));
    const onReport = jest.fn();
    const local = 'a3e64f617b3b669bdde0219230d25837de906adfbaae6d1c642c75f7e7afd0f8';
    renderCards([props({ view, onReport })], services({ localFingerprint: () => Promise.resolve(local) }));
    await waitFor(() => expect(within(card()).getByTestId('orion-viz-fingerprint')).toHaveAttribute('data-fingerprint', 'mismatch'));
    expect(within(card()).getByRole('status')).toHaveTextContent(
      'Frozen: the local data differs from the data this run used (fingerprint a3e64f61… here, 0f27e0bd… in the run)',
    );
    expect(within(card()).getByRole('table', { name: /Cited output/ })).toBeInTheDocument();
    expect(mockBind).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(onReport).toHaveBeenCalledWith(
        report(view, {
          mounted: false,
          error: `Frozen in mode H: the local fixture fingerprint ${local} differs from the run's ${FINGERPRINT}`,
        }),
      ),
    );
  });

  it('freezes when the local fingerprint cannot be read', async () => {
    const view = modeH(lastView('j1-complete'));
    renderCards([props({ view })], services({ localFingerprint: () => Promise.reject(new Error('healthcheck 503')) }));
    await waitFor(() =>
      expect(within(card()).getByRole('status')).toHaveTextContent(
        'Frozen: the local data could not be checked against this run (healthcheck 503).',
      ),
    );
    expect(mockBind).not.toHaveBeenCalled();
  });

  it('does not check outside mode H', async () => {
    const s = services();
    renderCards([props({ view: lastView('j1-complete') })], s);
    await waitFor(() => expect(phase(card())).toBe('mounted'));
    expect(s.localFingerprint).not.toHaveBeenCalled();
    expect(within(card()).queryByTestId('orion-viz-fingerprint')).not.toBeInTheDocument();
  });
});

describe('<VizCard /> viewer requests (C-36)', () => {
  let restore: typeof fetch;
  beforeEach(() => {
    restore = globalThis.fetch;
    globalThis.fetch = jest.fn((input: RequestInfo | URL) =>
      Promise.resolve({
        ok: true,
        status: 200,
        clone() {
          return this;
        },
        json: () => Promise.resolve(String(input).endsWith('/termdb/DE') ? { data: { cacheId: 'de-cache-1' } } : {}),
      } as unknown as Response),
    ) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = restore;
  });

  it("lists the viewer's requests and whether DE used s9's server cache entry", async () => {
    const view = lastView('j3-after-confirm');
    const loadCitedCall = jest.fn(() =>
      Promise.resolve({ callId: 'c', request: savedDeRunRequest(view), observed: { cacheId: 'de-cache-1' } }),
    );
    mockBehaviours.push(async (arg) => {
      // As dofetch3 does, through the global fetch.
      await globalThis.fetch('/protein-paint/termdb/config?embedder=localhost');
      await globalThis.fetch('/protein-paint/termdb/DE', { method: 'POST', body: '{}' });
      return mounts(arg);
    });
    renderCards([props({ view })], services({ loadCitedCall }));
    await waitFor(() => expect(phase(card())).toBe('mounted'));
    const requests = within(card()).getByTestId('orion-viz-requests');
    await waitFor(() => expect(requests).toHaveTextContent('Viewer requests (2)'));
    expect(requests).toHaveTextContent(/GET \/termdb\/config · 200 · \d+ ms · network/);
    await waitFor(() =>
      expect(requests).toHaveTextContent(/POST \/termdb\/DE · 200 · \d+ ms · server cache: same entry as s9 de_run/),
    );
    expect(requests).toHaveTextContent('Requests ProteinPaint answers from its in-page cache make no network call');
  });
});

describe('<VizCard /> narrow cards', () => {
  const original = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  afterEach(() => {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = original;
  });

  it('shows the cited output and the hand-off instead of a live chart below 720 px', async () => {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe() {
        this.callback([{ contentRect: { width: 600 } } as ResizeObserverEntry], this as unknown as ResizeObserver);
      }
      disconnect() {}
    };
    renderCards([props({ view: lastView('j1-complete') })]);
    await waitFor(() =>
      expect(within(card()).getByRole('status')).toHaveTextContent('The live chart needs a card at least 720 px wide'),
    );
    expect(mockBind).not.toHaveBeenCalled();
    expect(within(card()).getByRole('button', { name: 'Open with this cohort' })).toBeEnabled();
  });
});
