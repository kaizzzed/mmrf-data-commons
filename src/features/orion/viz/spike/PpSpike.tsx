import React, { useState } from 'react';
import { Button } from '@mantine/core';
import type { GqlFilter, PinnedViz, SampleGroup } from '../../agui/types';
import { OrionPpCard } from '../OrionPpCard';
import { caseIdOfSample, KRAS_MUTATED_SAMPLE_IDS, KRAS_NO_MUTATION_SAMPLE_IDS } from './krasGroups';

// Day 1 AM spike (RFA rev 25, A-2, Open questions 9 and 13); /?app=Assistant&spike=pp only.

const caseFilter = (sampleIds: readonly number[]): GqlFilter => ({
  and: [{ in: { case_id: sampleIds.map(caseIdOfSample) } }],
});

const KRAS_GROUPS: [SampleGroup, SampleGroup] = [
  { name: 'KRAS no mutation', sampleIds: KRAS_NO_MUTATION_SAMPLE_IDS },
  { name: 'KRAS mutated', sampleIds: KRAS_MUTATED_SAMPLE_IDS },
];

const DE_SORT_CAPTION = 'Table sorted by fold change. Sort by adjusted p-value to match the answer.';

interface SpikeCard {
  vizId: string;
  label: string;
  title: string;
  pinned: PinnedViz;
  caption?: string;
}

const SPIKE_CARDS: SpikeCard[] = [
  {
    vizId: 'survival',
    label: 'survival',
    title: 'Survival by CGS risk category · Correlation launcher',
    pinned: { kind: 'survival', filter0: null, term: 'overall_survival', overlay: 'cgs_risk_category' },
  },
  {
    vizId: 'oncomatrix',
    label: 'OncoMatrix',
    title: 'OncoMatrix · six fixed genes · KRAS-mutated cases',
    pinned: {
      kind: 'oncomatrix',
      filter0: caseFilter(KRAS_MUTATED_SAMPLE_IDS),
      genes: ['KRAS', 'NRAS', 'DIS3', 'MYC', 'BRAF', 'TP53'],
    },
  },
  {
    vizId: 'de-direct',
    label: 'DE direct',
    title: 'Differential expression · direct differentialAnalysis mount · Wilcoxon',
    pinned: { kind: 'deDirect', groups: KRAS_GROUPS, method: 'wilcoxon' },
    caption: DE_SORT_CAPTION,
  },
  {
    vizId: 'de-input',
    label: 'DEinput fallback',
    title: 'Differential expression · DEinput fallback · seeded cohort groups',
    pinned: {
      kind: 'deInput',
      groups: [
        {
          name: KRAS_GROUPS[0].name,
          cohortId: 'orion-spike-kras-no-mutation',
          filter0: caseFilter(KRAS_NO_MUTATION_SAMPLE_IDS),
        },
        {
          name: KRAS_GROUPS[1].name,
          cohortId: 'orion-spike-kras-mutated',
          filter0: caseFilter(KRAS_MUTATED_SAMPLE_IDS),
        },
      ],
    },
  },
  {
    vizId: 'de-rankby',
    label: 'DE sort probe',
    title: 'Differential expression · direct mount with rankBy pinned (Open question 9 probe)',
    pinned: {
      kind: 'deDirect',
      groups: KRAS_GROUPS,
      method: 'wilcoxon',
      volcano: { rankBy: 'adjustedPValue' },
    },
    caption: DE_SORT_CAPTION,
  },
];

/** Adds the spike's cards one at a time, the way answers add them to a thread. */
const PpSpike = () => {
  const [added, setAdded] = useState<string[]>([]);
  return (
    <section aria-label="ProteinPaint spike" data-testid="orion-pp-spike" className="flex flex-col gap-3">
      <p role="note" className="text-sm">
        Spike: native ProteinPaint viewers pinned to fixed inputs. At most two stay live; older cards
        freeze.
      </p>
      <div className="flex flex-wrap gap-2">
        {SPIKE_CARDS.map((card) => (
          <Button
            key={card.vizId}
            type="button"
            size="xs"
            disabled={added.includes(card.vizId)}
            onClick={() => setAdded((ids) => [...ids, card.vizId])}
            data-testid={`orion-spike-add-${card.vizId}`}
          >
            Add {card.label}
          </Button>
        ))}
        <Button
          type="button"
          size="xs"
          variant="outline"
          onClick={() => setAdded([])}
          data-testid="orion-spike-remove-all"
        >
          Remove all cards
        </Button>
      </div>
      {added.map((vizId) => {
        const card = SPIKE_CARDS.find((c) => c.vizId === vizId);
        return (
          card && (
            <OrionPpCard
              key={vizId}
              vizId={vizId}
              title={card.title}
              pinned={card.pinned}
              caption={card.caption}
            />
          )
        );
      })}
    </section>
  );
};

export default PpSpike;
