import React, { type ReactNode, type Ref } from 'react';
import { Paper } from '@mantine/core';

interface CardProps {
  titleId: string;
  title: ReactNode;
  /** Set when the card moves focus to its heading. */
  titleRef?: Ref<HTMLHeadingElement>;
  status?: ReactNode;
  children?: ReactNode;
  className?: string;
  'data-orion-viz'?: boolean;
}

export const Card = ({
  titleId,
  title,
  titleRef,
  status,
  children,
  className = '',
  ...rest
}: CardProps) => (
  <Paper
    component="section"
    withBorder
    radius="md"
    p="md"
    aria-labelledby={titleId}
    className={`flex flex-col gap-3 bg-base-max ${className}`}
    {...rest}
  >
    <header className="flex flex-wrap items-center justify-between gap-2">
      <h3
        id={titleId}
        ref={titleRef}
        tabIndex={titleRef ? -1 : undefined}
        // Not `text-base`: the theme has a `base` colour, so that class would also set near-white text.
        className="font-heading text-[1rem] font-semibold text-base-contrast-max focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        {title}
      </h3>
      {status}
    </header>
    {children}
  </Paper>
);
