import { webcrypto } from 'crypto';
import type { PinnedViz } from '../agui/types';
import {
  checkParity,
  citedStepLabel,
  parityDetail,
  parityOf,
  parityText,
  pinnedHashVerified,
  unchecked,
} from './parity';
import { pinnedHash } from './ppPinnedArgs';
import { lastView, onlySpec } from './testing';

const subtle = (globalThis.crypto?.subtle ?? webcrypto.subtle) as SubtleCrypto;

describe('checkParity', () => {
  it.each(['j1-complete', 'j3-after-confirm', 'oncomatrix', 'j3-dont-save'] as const)(
    "matches the %s fixture: the recomputed hash equals pinnedHash and requestPinnedHash",
    async (name) => {
      const spec = onlySpec(lastView(name));
      if (!spec.pinned) throw new Error('fixture spec is pinned');
      const parity = await checkParity(spec.pinned, spec, subtle);
      expect(parity).toEqual({ state: 'match', recomputed: spec.pinnedHash, reason: null });
      expect(pinnedHashVerified(parity)).toBe(true);
    },
  );

  it('says the chart would not reproduce the cited request when only requestPinnedHash differs', async () => {
    const spec = onlySpec(lastView('j1-complete'));
    if (!spec.pinned) throw new Error('fixture spec is pinned');
    const parity = await checkParity(spec.pinned, { ...spec, requestPinnedHash: '0'.repeat(64) }, subtle);
    expect(parity.state).toBe('requestDiffers');
    expect(pinnedHashVerified(parity)).toBe(false);
  });

  it('flags inputs that do not hash to the recorded pinnedHash', async () => {
    const spec = onlySpec(lastView('j1-complete'));
    const tampered: PinnedViz = { kind: 'survival', filter0: { and: [] }, term: 'overall_survival', overlay: 'cgs_risk_category' };
    const parity = await checkParity(tampered, spec, subtle);
    expect(parity.state).toBe('pinnedDiffers');
    expect(parity.recomputed).toBe(await pinnedHash(tampered, subtle));
    expect(pinnedHashVerified(parity)).toBe(false);
  });

  it('is not checked when the pinned inputs cannot be hashed', async () => {
    const spec = onlySpec(lastView('j3-after-confirm'));
    const unhashable: PinnedViz = {
      kind: 'deDirect',
      groups: [
        { name: 'A', sampleIds: [1] },
        { name: 'B', sampleIds: [2] },
      ],
      method: 'wilcoxon',
      volcano: { pValue: 0.00005 },
    };
    const parity = await checkParity(unhashable, spec, subtle);
    expect(parity.state).toBe('unchecked');
    expect(parity.reason).toMatch(/Cannot hash/);
    expect(pinnedHashVerified(parity)).toBeNull();
  });
});

describe('parity words', () => {
  const view = lastView('j1-complete');
  const spec = onlySpec(view);
  const cited = citedStepLabel(spec, view.steps);

  it('names the cited step by id and tool', () => {
    expect(cited).toBe('s4 survival_compare');
    expect(citedStepLabel({ citesSteps: ['s99'] }, view.steps)).toBe('s99');
  });

  it('gives each state one short label and a longer explanation', () => {
    const match = parityOf(spec.pinnedHash, spec);
    expect(parityText(match, cited)).toBe('Parity: matches s4 survival_compare');
    expect(parityText(parityOf(spec.pinnedHash, { ...spec, requestPinnedHash: 'x' }), cited)).toBe(
      'Parity: differs from s4 survival_compare',
    );
    expect(parityText(parityOf('y', spec), cited)).toBe('Parity: pinned inputs changed');
    expect(parityText({ state: 'checking', recomputed: null, reason: null }, cited)).toBe('Parity: checking');
    expect(parityText(unchecked('no inputs'), cited)).toBe('Parity: not checked');
    expect(parityDetail(unchecked('no inputs'), cited)).toBe('The pinned inputs could not be checked: no inputs.');
    expect(parityDetail(parityOf(spec.pinnedHash, { ...spec, requestPinnedHash: 'x' }), cited)).toMatch(
      /would not reproduce the cited request/,
    );
  });
});
