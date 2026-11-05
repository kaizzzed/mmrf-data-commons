// The parity badge (C-21; contract "Parity badge"): the browser recomputes pinnedHash from the
// pinned inputs it mounts and shows a match only when that value equals both the spec's pinnedHash
// and its requestPinnedHash (the hash of what the cited step's request implies).

import type { PinnedViz, Step, VizSpec } from '../agui/types';
import { pinnedHash } from './ppPinnedArgs';

export type ParityState =
  /** The hash is being computed, or the pinned inputs are still loading. */
  | 'checking'
  /** recomputed == pinnedHash == requestPinnedHash: the chart reproduces the cited request. */
  | 'match'
  /** recomputed == pinnedHash, but the cited request implies other inputs (a valid spec). */
  | 'requestDiffers'
  /** The inputs the card holds do not hash to the spec's pinnedHash. */
  | 'pinnedDiffers'
  /** No pinned inputs to hash, or hashing failed. */
  | 'unchecked';

export interface Parity {
  state: ParityState;
  /** The browser's recomputed pinnedHash, when it has one. */
  recomputed: string | null;
  /** Why the check could not run (unchecked only). */
  reason: string | null;
}

export const CHECKING: Parity = { state: 'checking', recomputed: null, reason: null };

export const parityOf = (recomputed: string, spec: Pick<VizSpec, 'pinnedHash' | 'requestPinnedHash'>): Parity => ({
  state:
    recomputed !== spec.pinnedHash
      ? 'pinnedDiffers'
      : recomputed !== spec.requestPinnedHash
        ? 'requestDiffers'
        : 'match',
  recomputed,
  reason: null,
});

export const unchecked = (reason: string): Parity => ({ state: 'unchecked', recomputed: null, reason });

/** Recomputes pinnedHash and compares it with the spec's two hashes; never rejects. */
export const checkParity = async (
  pinned: PinnedViz,
  spec: Pick<VizSpec, 'pinnedHash' | 'requestPinnedHash'>,
  subtle?: SubtleCrypto,
): Promise<Parity> => {
  try {
    return parityOf(await pinnedHash(pinned, subtle), spec);
  } catch (error) {
    return unchecked(error instanceof Error ? error.message : String(error));
  }
};

/** VizReport.pinnedHashVerified: true on a match, false on a mismatch, null when not checked. */
export const pinnedHashVerified = (parity: Parity): boolean | null => {
  switch (parity.state) {
    case 'match':
      return true;
    case 'requestDiffers':
    case 'pinnedDiffers':
      return false;
    case 'checking':
    case 'unchecked':
      return null;
  }
};

/** "s4 survival_compare": the cited step, as its plan row names it. */
export const citedStepLabel = (spec: Pick<VizSpec, 'citesSteps'>, steps: readonly Step[]): string => {
  const [stepId] = spec.citesSteps;
  const step = steps.find((s) => s.id === stepId);
  return step ? `${step.id} ${step.tool}` : stepId;
};

/** The badge's words; the icon beside it carries the same state, so color is never the only cue. */
export const parityText = (parity: Parity, cited: string): string => {
  switch (parity.state) {
    case 'checking':
      return 'Parity: checking';
    case 'match':
      return `Parity: matches ${cited}`;
    case 'requestDiffers':
      return `Parity: differs from ${cited}`;
    case 'pinnedDiffers':
      return 'Parity: pinned inputs changed';
    case 'unchecked':
      return 'Parity: not checked';
  }
};

/** The badge's longer explanation (its tooltip and accessible description). */
export const parityDetail = (parity: Parity, cited: string): string => {
  switch (parity.state) {
    case 'checking':
      return 'Comparing the chart’s pinned inputs with the cited step’s request.';
    case 'match':
      return `The chart’s pinned inputs are exactly the inputs ${cited}’s request implies.`;
    case 'requestDiffers':
      return `The chart’s pinned inputs differ from the inputs ${cited}’s request implies, so the chart would not reproduce the cited request.`;
    case 'pinnedDiffers':
      return 'The inputs this card holds do not match the pinned inputs the run recorded.';
    case 'unchecked':
      return `The pinned inputs could not be checked${parity.reason ? `: ${parity.reason}` : ''}.`;
  }
};
