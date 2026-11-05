import React, { type ReactElement } from 'react';
import { readFileSync } from 'fs';
import path from 'path';
import { MantineProvider } from '@mantine/core';
import { render, type RenderResult } from '@testing-library/react';
import { createSseParser } from './agui/sseParser';
import type { AguiEvent } from './agui/types';

/** Test-only helpers; nothing in the app imports this module. */

export const FIXTURE_PATH = path.join(__dirname, 'agui', '__fixtures__', 'j1-stub.events.jsonl');

export const readFixtureBytes = (): Uint8Array => new Uint8Array(readFileSync(FIXTURE_PATH));

export const fixtureEvents = (): AguiEvent[] =>
  createSseParser()
    .push(readFixtureBytes())
    .map((item) => {
      if (item.kind !== 'event') throw new Error(`Fixture frame failed: ${item.error.message}`);
      return item.event;
    });

export const renderWithMantine = (ui: ReactElement): RenderResult =>
  render(<MantineProvider>{ui}</MantineProvider>);
