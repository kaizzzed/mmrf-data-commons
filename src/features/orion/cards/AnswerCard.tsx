import React, { useId } from 'react';
import { Button } from '@mantine/core';
import { LuExternalLink, LuMessageSquarePlus, LuPenLine } from 'react-icons/lu';
import type { FollowUp, Limitation, OpenLink, RunStatus, RunView, Sentence, VerifierRule } from '../agui/types';
import { SYNTHETIC_NOTICE } from '../constants';
import { Card } from './Card';
import { factMap, Segments, type FactLookup } from './FactChip';

const DEFAULT_WITHHELD_REASON: Partial<Record<RunStatus, string>> = {
  Partial: 'a step failed',
  Cancelled: 'you stopped the run',
  Interrupted: 'the run was interrupted',
  ObservedOnly: 'the model text did not pass verification',
  Limited: 'a limitation stopped the run',
};

export const withheldLine = (view: Pick<RunView, 'withheldReason'>, status: RunStatus): string =>
  `Interpretation withheld: ${
    view.withheldReason ?? DEFAULT_WITHHELD_REASON[status] ?? 'no interpretation is available'
  }`;

const DROPPED_RULE: Record<VerifierRule, string> = {
  'V-NUM': 'it stated a number no tool returned',
  'V-REF': 'it cited no fact',
  'V-ENT': 'it named something no tool returned',
  'V-SEC': 'it broke a safety rule',
  'V-COMP': 'it left out a required part',
  'V-LIM': 'it contradicted a limitation',
};

const SentenceText = ({
  sentence,
  facts,
  onCite,
}: {
  sentence: Sentence;
  facts: FactLookup;
  onCite?: (factId: string) => void;
}) =>
  sentence.dropped ? (
    <p className="text-sm italic">
      A sentence was removed by the verifier ({sentence.dropped}): {DROPPED_RULE[sentence.dropped]}.
    </p>
  ) : (
    <p className="text-sm leading-relaxed">
      <Segments segments={sentence.segments} facts={facts} onCite={onCite} />
    </p>
  );

export const LimitationLine = ({
  limitation,
  facts,
  onCite,
}: {
  limitation: Limitation;
  facts: FactLookup;
  onCite?: (factId: string) => void;
}) => (
  <>
    <p>
      {limitation.segments ? (
        <Segments segments={limitation.segments} facts={facts} onCite={onCite} />
      ) : (
        limitation.text
      )}
    </p>
    {limitation.unblock && (
      <p>
        <span className="font-medium">What would unblock it:</span> {limitation.unblock}
      </p>
    )}
  </>
);

/** How an "Open <app>" link hands off, from the run's scope (handoff.ts scopeHandoff). */
export interface OpenLinkHandoff {
  /** The click makes the run's cohort active first: the button says so. */
  switches: boolean;
  cohortName: string | null;
  /** Set when the link is off; shown beside it. */
  disabledReason: string | null;
}

export interface AnswerCardProps {
  status: RunStatus;
  view: RunView;
  onCite?: (factId: string) => void;
  /** A follow-up chip asks its question as a new turn. */
  onAsk?: (followUp: FollowUp) => void;
  /** "Open <app>": click-only, same-tab, on the run's scope; a switch of active cohort is named. */
  onOpenLink?: (link: OpenLink) => void;
  /** The hand-off each link makes; absent, a link opens the app with no cohort switch. */
  openLinkHandoff?: (link: OpenLink) => OpenLinkHandoff | null;
}

const OpenLinkButton = ({
  link,
  handoff,
  onOpenLink,
}: {
  link: OpenLink;
  handoff: OpenLinkHandoff | null;
  onOpenLink?: (link: OpenLink) => void;
}) => {
  const reasonId = useId();
  const reason = handoff?.disabledReason ?? null;
  return (
    <li className="flex flex-wrap items-center gap-2">
      <Button
        type="button"
        variant="subtle"
        size="compact-sm"
        disabled={!onOpenLink || reason !== null}
        aria-describedby={reason ? reasonId : undefined}
        title={handoff?.switches && handoff.cohortName ? `Makes ${handoff.cohortName} the active cohort first` : undefined}
        rightSection={<LuExternalLink aria-hidden focusable="false" />}
        onClick={() => onOpenLink?.(link)}
      >
        {handoff?.switches ? `Make active and open ${link.title}` : `Open ${link.title}`}
      </Button>
      {reason && (
        <span id={reasonId} className="text-xs">
          {reason}
        </span>
      )}
    </li>
  );
};

const hasModelText = (view: RunView): boolean => view.interpretation !== null && view.interpretation.length > 0;

/**
 * Every Complete answer has four labeled parts in a fixed order (FR-15, C-10): Observed,
 * Interpretation, Hypotheses and next steps, Limitations. While Answering, Observed and
 * Limitations show first with "Writing interpretation" (C-22); any other end state shows
 * "Interpretation withheld: <reason>" in place of the model's two parts.
 */
export const AnswerCard = ({ status, view, onCite, onAsk, onOpenLink, openLinkHandoff }: AnswerCardProps) => {
  const titleId = useId();
  const facts = factMap(view.facts);
  const interpreted = hasModelText(view);
  const sentences = (items: Sentence[]) =>
    items.map((sentence, i) => <SentenceText key={i} sentence={sentence} facts={facts} onCite={onCite} />);
  const supersededAnswers = view.superseded.filter((s) => s.hadAnswer);
  const followUps = view.followUps;
  const openLinks = view.openLinks;

  return (
    <Card titleId={titleId} title="Answer">
      {supersededAnswers.length > 0 && (
        <p role="note" className="text-sm">
          This answer replaces the version {supersededAnswers.map((s) => s.planVersion).join(', ')} answer, which an edit
          superseded. The run record keeps it.
        </p>
      )}
      <div>
        <h4 className="text-sm font-semibold">Observed</h4>
        {view.observed.length > 0 ? sentences(view.observed) : <p className="text-sm">No tool output to report.</p>}
      </div>
      {interpreted ? (
        <>
          <div>
            <h4 className="text-sm font-semibold">Interpretation</h4>
            {sentences(view.interpretation ?? [])}
          </div>
          <div>
            <h4 className="text-sm font-semibold">Hypotheses and next steps</h4>
            {sentences(view.hypotheses ?? [])}
            {followUps.length > 0 && (
              <ul aria-label="Follow-up questions" className="mt-2 flex flex-wrap gap-2">
                {followUps.map((followUp) => (
                  <li key={followUp.question}>
                    <Button
                      type="button"
                      variant="default"
                      radius="xl"
                      size="compact-sm"
                      disabled={!onAsk}
                      leftSection={<LuMessageSquarePlus aria-hidden focusable="false" />}
                      title={followUp.question}
                      onClick={() => onAsk?.(followUp)}
                    >
                      {followUp.label}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {openLinks.length > 0 && (
              <ul aria-label="Other apps" className="mt-2 flex flex-wrap gap-2">
                {openLinks.map((link) => (
                  <OpenLinkButton
                    key={link.appId}
                    link={link}
                    handoff={openLinkHandoff?.(link) ?? null}
                    onOpenLink={onOpenLink}
                  />
                ))}
              </ul>
            )}
          </div>
        </>
      ) : status === 'Answering' ? (
        <p className="inline-flex items-center gap-1 text-sm">
          <LuPenLine aria-hidden focusable="false" />
          Writing interpretation
        </p>
      ) : (
        <p className="text-sm">{withheldLine(view, status)}</p>
      )}
      {view.limitations.length > 0 && (
        <div>
          <h4 className="text-sm font-semibold">Limitations</h4>
          <ul className="list-disc pl-5 text-sm">
            {view.limitations.map((l, i) => (
              <li key={`${l.code}-${i}`}>
                <LimitationLine limitation={l} facts={facts} onCite={onCite} />
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="text-xs">{view.notice || SYNTHETIC_NOTICE}</p>
    </Card>
  );
};
