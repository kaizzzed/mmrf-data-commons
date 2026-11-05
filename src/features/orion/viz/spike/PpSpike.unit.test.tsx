import React from 'react';
import { MantineProvider } from '@mantine/core';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createLiveVizRegistry, LiveVizContext } from '../liveViz';
import PpSpike from './PpSpike';

interface BindCall {
  rootElem: HTMLElement;
  initArgs: Record<string, unknown>;
}

const mockBind = jest.fn((arg: BindCall) => {
  arg.rootElem.appendChild(document.createElement('svg'));
  const matrix = (arg.initArgs.opts as { matrix?: { callbacks: Record<string, () => void> } } | undefined)?.matrix;
  if (matrix) setTimeout(matrix.callbacks['postRender.orion'], 0);
  return Promise.resolve({ triggerAbort: jest.fn(), destroy: jest.fn() });
});

jest.mock('@sjcrh/proteinpaint-client', () => ({
  bindProteinPaint: (arg: BindCall) => mockBind(arg),
}));

describe('<PpSpike />', () => {
  it('adds the spike cards one at a time, keeps two live, and removes them all', async () => {
    render(
      <MantineProvider>
        <LiveVizContext.Provider value={createLiveVizRegistry()}>
          <PpSpike />
        </LiveVizContext.Provider>
      </MantineProvider>,
    );
    await userEvent.click(screen.getByTestId('orion-spike-add-survival'));
    await userEvent.click(screen.getByTestId('orion-spike-add-oncomatrix'));
    await userEvent.click(screen.getByTestId('orion-spike-add-de-direct'));
    await waitFor(() => expect(screen.getByTestId('orion-viz-de-direct')).toHaveAttribute('data-phase', 'mounted'));
    await waitFor(() => expect(screen.getByTestId('orion-viz-oncomatrix')).toHaveAttribute('data-phase', 'mounted'));
    expect(screen.getByTestId('orion-viz-survival')).toHaveAttribute('data-phase', 'frozen');
    expect(screen.getByTestId('orion-spike-add-survival')).toBeDisabled();
    expect(mockBind).toHaveBeenCalledTimes(3);

    await userEvent.click(screen.getByTestId('orion-spike-remove-all'));
    expect(screen.queryByTestId('orion-viz-survival')).not.toBeInTheDocument();
    expect(screen.getByTestId('orion-spike-add-survival')).toBeEnabled();
  });
});
