import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import path from 'path';
import { COHORT_DEF_SCHEMA, type CanonicalDefinition, type SaveCohortsArgs, type WireFilterSet } from '../agui/types';
import { streamEvents } from '../testing';
import {
  canonicalDefinition,
  compareCodePoints,
  defSha256,
  DefinitionError,
  definitionFromFilterSet,
  filterSetForDefinition,
  filterSetSha256,
  normalizeDefinition,
} from './cohortDef';

/** orion/contracts/fixtures/cohort-def-vectors.json, copied byte for byte. */
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

  it("gives the platform's case-list and facet FilterSets the hash of their definitions", () => {
    const groups = new Map<string, string[]>();
    for (const v of VECTORS) if (v.sha256) groups.set(v.sha256, [...(groups.get(v.sha256) ?? []), v.name]);
    const sizes = [...groups.values()].map((names) => names.length).sort((a, b) => a - b);
    expect(sizes.slice(-3)).toEqual([2, 2, 4]);
  });
});

describe('defSha256 (the cohort adapter)', () => {
  const definitions = VECTORS.filter((v) => v.definition);
  const filterSets = VECTORS.filter((v) => v.filterSet);

  it.each(definitions.map((v) => [v.name, v] as const))('reproduces the definition vector: %s', (_name, vector) => {
    const definition = vector.definition as CanonicalDefinition;
    expect(canonicalDefinition(definition)).toBe(vector.canonical);
    expect(defSha256(definition)).toBe(vector.sha256);
  });

  it.each(filterSets.map((v) => [v.name, v] as const))('reproduces the FilterSet vector: %s', (_name, vector) => {
    const definition = definitionFromFilterSet(vector.filterSet);
    if (vector.canonical === null) {
      expect(definition).toBeNull();
      expect(filterSetSha256(vector.filterSet)).toBeNull();
      return;
    }
    expect(definition).not.toBeNull();
    expect(canonicalDefinition(definition as CanonicalDefinition)).toBe(vector.canonical);
    expect(filterSetSha256(vector.filterSet)).toBe(vector.sha256);
  });

  it.each(VECTORS.filter((v) => v.canonical !== null).map((v) => [v.name, v] as const))(
    'writes a FilterSet that reads back as the same definition: %s',
    (_name, vector) => {
      const definition = vector.definition ?? definitionFromFilterSet(vector.filterSet);
      const written = filterSetForDefinition(definition as CanonicalDefinition);
      expect(filterSetSha256(written)).toBe(vector.sha256);
    },
  );

  it("writes a case-ID list as the platform's own case_id in form, ids sorted", () => {
    expect(filterSetForDefinition({ kind: 'case_ids', caseIds: ['SYNTH-CASE-0010', 'SYNTH-CASE-0003', 'SYNTH-CASE-0003'] })).toEqual({
      mode: 'and',
      root: { case_id: { operator: 'in', field: 'case_id', operands: ['SYNTH-CASE-0003', 'SYNTH-CASE-0010'] } },
    });
  });

  it('writes a filter as one root entry per field, several clauses joined by and', () => {
    expect(
      filterSetForDefinition({
        kind: 'filter',
        clauses: [
          { field: 'diagnoses.age_at_diagnosis', op: '>=', values: [65] },
          { field: 'demographic.race', op: 'in', values: ['white', 'asian'] },
          { field: 'diagnoses.age_at_diagnosis', op: '<', values: [75.5] },
        ],
      }),
    ).toEqual({
      mode: 'and',
      root: {
        'demographic.race': { operator: 'includes', field: 'demographic.race', operands: ['asian', 'white'] },
        'diagnoses.age_at_diagnosis': {
          operator: 'and',
          operands: [
            { operator: '<', field: 'diagnoses.age_at_diagnosis', operand: 75.5 },
            { operator: '>=', field: 'diagnoses.age_at_diagnosis', operand: 65 },
          ],
        },
      },
    });
  });

  it("hashes the J3 pause's pending definitions to the agent's defSha256", () => {
    const events = streamEvents('j3-save-pause');
    const args = JSON.parse(
      events.flatMap((e) => (e.type === 'TOOL_CALL_ARGS' ? [e.delta] : [])).join(''),
    ) as SaveCohortsArgs;
    expect(args.cohorts).toHaveLength(2);
    for (const cohort of args.cohorts) {
      expect(defSha256(cohort.definition)).toBe(cohort.defSha256);
      expect(filterSetSha256(filterSetForDefinition(cohort.definition))).toBe(cohort.defSha256);
    }
  });
});

describe('reading FilterSets ORION cannot use', () => {
  it.each([
    ['null', null],
    ['no root', { mode: 'and' }],
    ['another mode', { mode: 'xor', root: {} }],
    ['an operation that is not an object', { mode: 'and', root: { race: 'white' } }],
    ['an empty includes', { mode: 'and', root: { race: { operator: 'includes', field: 'race', operands: [] } } }],
    ['a nested operand', { mode: 'and', root: { race: { operator: 'includes', field: 'race', operands: [['white']] } } }],
    ['a boolean operand', { mode: 'and', root: { alive: { operator: '=', field: 'alive', operand: true } } }],
    ['mixed value types', { mode: 'and', root: { x: { operator: 'includes', field: 'x', operands: ['a', 1] } } }],
    ['a missing operand', { mode: 'and', root: { x: { operator: '>', field: 'x' } } }],
    ['a bad case id', { mode: 'and', root: { case_id: { operator: 'in', field: 'case_id', operands: ['has space'] } } }],
    [
      'more than 20 clauses',
      {
        mode: 'and',
        root: Object.fromEntries(
          Array.from({ length: 21 }, (_, i) => [`f${i}`, { operator: '=', field: `f${i}`, operand: 'v' }]),
        ),
      },
    ],
  ])('returns null, never throwing, for %s', (_label, filters) => {
    expect(definitionFromFilterSet(filters)).toBeNull();
  });

  it('reads or over a single field like and', () => {
    const filters = { mode: 'or', root: { race: { operator: 'includes', field: 'race', operands: ['white'] } } };
    expect(definitionFromFilterSet(filters)).toEqual({
      kind: 'filter',
      clauses: [{ field: 'race', op: 'in', values: ['white'] }],
    });
  });

  it('rejects definitions the contract does not allow', () => {
    expect(() => normalizeDefinition({ kind: 'filter', clauses: [{ field: 'x', op: '>', values: [1, 2] }] })).toThrow(
      DefinitionError,
    );
    expect(() => canonicalDefinition({ kind: 'filter', clauses: [{ field: 'x', op: '>', values: [5e-5] }] })).toThrow(
      DefinitionError,
    );
    expect(() =>
      normalizeDefinition({ kind: 'case_ids', caseIds: Array.from({ length: 10_001 }, (_, i) => `C-${i}`) }),
    ).toThrow('More than 10000 case ids');
  });
});

describe('compareCodePoints', () => {
  it('orders by code point, as Python does, not by UTF-16 unit', () => {
    // U+FF5E sorts before U+1F600 by code point, after it by UTF-16 unit (0xD83D).
    expect(['\u{1F600}', '～'].sort(compareCodePoints)).toEqual(['～', '\u{1F600}']);
    expect(['b', 'a', 'B', 'ab'].sort(compareCodePoints)).toEqual(['B', 'a', 'ab', 'b']);
    expect(compareCodePoints('same', 'same')).toBe(0);
  });
});
