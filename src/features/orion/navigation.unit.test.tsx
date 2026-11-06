// The Assistant is one click from every page: the header's top navigation links to it.

import React from 'react';
import { existsSync } from 'fs';
import path from 'path';
import { MantineProvider } from '@mantine/core';
import { render, screen, within } from '@testing-library/react';
import DesktopView from '@/components/Navigation/MainNavigation/Components/DesktopView';
import type { Navigation } from '@/components/Navigation/MainNavigation/navigationInterfaces';
import analysisTools from '../../../config/gen3/analysisTools.json';
import navigationJSON from '../../../config/mmrf/mainNavigation.json';

const { navigation } = navigationJSON as { navigation: Navigation };
const PUBLIC = path.join(__dirname, '..', '..', '..', 'public');
const NAMES = ['Analysis Center', 'Assistant', 'Projects', 'Cohort Builder', 'Repository', 'Discovery', 'Workspaces'];

describe('the top navigation', () => {
  it('lists Assistant right after Analysis Center, opening /?app=Assistant', () => {
    expect(navigation.items.map((item) => item.name)).toEqual(NAMES);
    const assistant = navigation.items[1];
    expect(assistant.href).toBe('/?app=Assistant');
    // The icon the Analysis Tools card of the same app uses, and a file that exists.
    const card = analysisTools.sections.flatMap((s) => s.tools).find((t) => t.appId === 'Assistant');
    expect(card?.icon).toBe(assistant.icon);
    for (const item of navigation.items) expect(existsSync(path.join(PUBLIC, item.icon))).toBe(true);
  });

  it('renders it as a header link, and marks no item current (none claims /?app=Assistant with Analysis Center)', () => {
    render(
      <MantineProvider>
        <DesktopView navigation={navigation} />
      </MantineProvider>,
    );
    const links = screen.getByTestId('mmrf-mainNavigation-links');
    expect(within(links).getAllByRole('link').map((a) => a.textContent)).toEqual(NAMES);
    expect(within(links).getByRole('link', { name: 'Assistant' })).toHaveAttribute('href', '/?app=Assistant');
    expect(within(links).getByRole('link', { name: 'Analysis Center' })).toHaveAttribute('href', '/');
    expect(links.querySelectorAll('[aria-current]')).toHaveLength(0);
  });

  it('spaces the seven links to fit beside the logo at 1280px, with 16px labels below xl', () => {
    // Measured in the platform header at 18px Montserrat: with 16px gaps and 8px before each icon
    // the row ends at the bar's padding with no page scroll from 1263px (1280 less a classic
    // scrollbar) up; the 32px of before overflowed at 1280. jsdom has no layout, so the classes stand in.
    render(
      <MantineProvider>
        <DesktopView navigation={navigation} />
      </MantineProvider>,
    );
    const links = screen.getByTestId('mmrf-mainNavigation-links');
    expect(links).toHaveClass('space-x-2');
    expect(links).not.toHaveClass('space-x-4');
    for (const link of within(links).getAllByRole('link')) {
      expect(link).toHaveClass('whitespace-nowrap', 'text-base', 'xl:text-lg');
      expect(link).not.toHaveClass('text-lg');
      const icon = link.querySelector('img');
      expect(icon).toHaveClass('ml-2', 'mr-2');
      expect(icon).not.toHaveClass('ml-4');
    }
  });
});
