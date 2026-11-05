import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import path from 'path';
import { COHORT_DEF_SCHEMA, type CanonicalDefinition, type WireFilterSet } from '../agui/types';

/**
 * orion/contracts/fixtures/cohort-def-vectors.json, copied byte for byte. The cohort adapter
 * computes defSha256 for saved cohorts to find reuse matches; until it lands, this suite checks
 * the vector file itself and leaves the reproduction as a todo for the cohort adapter.
 */
interface CohortDefVector {
  name: string;
  definition?: CanonicalDefinition;
  filterSet?: WireFilterSet;
  canonical: string | null;
  sha256: string | null;
}

const VECTORS = (
  JSON.parse(readFileSync(path.join(__dirname, '__fixtures__', 'cohort-def-vectors.json'), 'utf8')) as {
    schema: string;
    vectors: CohortDefVector[];
  }
).vectors;

describe('cohort-def-vectors.json', () => {
  it('pairs every canonical definition with its sha256, and null with null', () => {
    for (const vector of VECTORS) {
      expect(!!vector.definition !== !!vector.filterSet).toBe(true);
      if (vector.canonical === null) {
        expect(vector.sha256).toBeNull();
        continue;
      }
      expect(JSON.parse(vector.canonical)).toMatchObject({ schema: COHORT_DEF_SCHEMA });
      expect(createHash('sha256').update(vector.canonical, 'utf8').digest('hex')).toBe(vector.sha256);
    }
  });

  it('gives the platform\'s case-list and facet FilterSets the hash of their definitions', () => {
    const groups = new Map<string, string[]>();
    for (const v of VECTORS) if (v.sha256) groups.set(v.sha256, [...(groups.get(v.sha256) ?? []), v.name]);
    const sizes = [...groups.values()].map((names) => names.length).sort((a, b) => a - b);
    expect(sizes.slice(-3)).toEqual([2, 2, 4]);
  });

  it.todo(
    'reproduces every canonical and sha256 in cohort-def-vectors.json from definition and filterSet (cohort adapter: defSha256)',
  );
});
