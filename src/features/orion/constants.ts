export const SYNTHETIC_NOTICE =
  'Synthetic sandbox — all data is fabricated and has no clinical meaning.';

export const FIXTURE_NOTICE =
  'Fixture replay: recorded stub values, not tool results. Every question gets the same recorded J1 run.';

export type Journey = 'J1' | 'J2' | 'J3';
export type Phrasing = 'tool-named' | 'open-ended';

export interface ReferencePrompt {
  journey: Journey;
  phrasing: Phrasing;
  text: string;
}

// Open-ended wording is R3's; tool-named wording names R3's tools for each journey.
export const REFERENCE_PROMPTS: readonly ReferencePrompt[] = [
  {
    journey: 'J1',
    phrasing: 'tool-named',
    text: 'Use Correlation Plot to compare Kaplan–Meier survival of CGS high-risk vs. CGS standard-risk patients',
  },
  {
    journey: 'J1',
    phrasing: 'open-ended',
    text: 'Compare survival of CGS high-risk vs. CGS standard-risk patients',
  },
  {
    journey: 'J2',
    phrasing: 'tool-named',
    text: 'Use Cohort Builder to build a cohort of Black or African American patients, then show its top 3 most frequently mutated genes in OncoMatrix',
  },
  {
    journey: 'J2',
    phrasing: 'open-ended',
    text: 'Top 3 most frequently mutated genes in Black or African American patients',
  },
  {
    journey: 'J3',
    phrasing: 'tool-named',
    text: 'Use the Gen3 Analysis API to find patients with and without a KRAS mutation, then run Differential Expression between them and show the top 10 genes',
  },
  {
    journey: 'J3',
    phrasing: 'open-ended',
    text: 'Differential expression between patients with and without a KRAS mutation, top 10 genes',
  },
];

/** The longest question an ask carries (contract `ask.question`, 1–4000 characters). */
export const MAX_QUESTION_CHARS = 4000;

/** The most saved cohorts a turn's cohortContext carries (the agent's CohortContext schema). */
export const MAX_SAVED_COHORTS = 200;
