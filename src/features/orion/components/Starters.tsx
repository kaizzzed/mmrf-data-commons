import React from 'react';
import { UnstyledButton } from '@mantine/core';
import { REFERENCE_PROMPTS } from '../constants';

/** The six reference prompts, offered on a thread's first use. */
export const Starters = ({ onPick }: { onPick: (prompt: string) => void }) => (
  <section aria-label="Example questions" className="flex flex-col gap-2">
    <h3 className="text-sm font-semibold">Try a reference question</h3>
    <ul className="grid gap-2 md:grid-cols-2">
      {REFERENCE_PROMPTS.map((prompt) => (
        <li key={`${prompt.journey}-${prompt.phrasing}`}>
          <UnstyledButton
            onClick={() => onPick(prompt.text)}
            className="h-full w-full rounded-md border border-base-lighter p-3 text-left text-sm hover:bg-base-lightest"
          >
            <span className="block text-xs font-medium">
              {prompt.journey} · {prompt.phrasing}
            </span>
            {prompt.text}
          </UnstyledButton>
        </li>
      ))}
    </ul>
  </section>
);
