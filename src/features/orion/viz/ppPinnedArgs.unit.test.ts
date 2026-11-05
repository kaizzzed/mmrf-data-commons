import { createHash, webcrypto } from 'crypto';
import { readFileSync } from 'fs';
import path from 'path';
import type { PinnedViz, StateSnapshotEvent, VizSpec } from '../agui/types';
import { fixtureEvents } from '../testing';
import {
  buildLauncherArgs,
  canonicalJson,
  pinnedDocument,
  pinnedFromVizSpec,
  pinnedHash,
} from './ppPinnedArgs';

const subtle = (globalThis.crypto?.subtle ?? webcrypto.subtle) as SubtleCrypto;

/** orion/contracts/fixtures/viz-pinned-vectors.json, copied byte for byte. */
interface PinnedVector {
  name: string;
  pinned: PinnedViz;
  canonical: string;
  sha256: string;
}
const VECTORS: PinnedVector[] = (
  JSON.parse(
    readFileSync(path.join(__dirname, '__fixtures__', 'viz-pinned-vectors.json'), 'utf8'),
  ) as { vectors: PinnedVector[] }
).vectors;
const hash = (pinned: PinnedViz) => pinnedHash(pinned, subtle);
const HOST = '/protein-paint';

const survival: PinnedViz = {
  kind: 'survival',
  filter0: null,
  term: 'overall_survival',
  overlay: 'cgs_risk_category',
};

const deDirect: PinnedViz = {
  kind: 'deDirect',
  groups: [
    { name: 'KRAS no mutation', sampleIds: [9, 3, 7] },
    { name: 'KRAS mutated', sampleIds: [4, 1, 2] },
  ],
  method: 'wilcoxon',
};

describe('buildLauncherArgs', () => {
  it('pins survival through the Correlation launcher with ids only', () => {
    expect(buildLauncherArgs(survival, HOST)).toEqual({
      host: HOST,
      dslabel: 'MMRF',
      genome: 'hg38',
      noheader: true,
      nobox: true,
      filter0: null,
      launchGdcCorrelation: true,
      state: {
        plots: [{ chartType: 'survival', term: { id: 'overall_survival' }, term2: { id: 'cgs_risk_category' } }],
      },
    });
  });

  it('pins OncoMatrix genes and scope, so no topMutatedGenes call decides the rows', () => {
    const filter0 = { and: [{ in: { case_id: ['SYNTH-CASE-0001'] } }] };
    expect(buildLauncherArgs({ kind: 'oncomatrix', filter0, genes: ['KRAS', 'NRAS'] }, HOST)).toEqual({
      host: HOST,
      dslabel: 'MMRF',
      genome: 'hg38',
      noheader: true,
      nobox: true,
      filter0,
      launchGdcMatrix: true,
      hide_dsHandles: true,
      genes: ['KRAS', 'NRAS'],
      settings: { matrix: { maxGenes: 50 } },
    });
  });

  it('builds the differentialAnalysis plot DEinput dispatches, with sorted samples and filter0 null', () => {
    const args = buildLauncherArgs(deDirect, HOST);
    if (!('launchGdcDE' in args)) throw new Error('expected a DE launcher');
    expect(args.filter0).toBeNull();
    const control = { name: 'KRAS no mutation', in: true, values: [3, 7, 9].map((sampleId) => ({ sampleId })) };
    const kase = { name: 'KRAS mutated', in: true, values: [1, 2, 4].map((sampleId) => ({ sampleId })) };
    expect(args.state.plots).toEqual([
      {
        chartType: 'differentialAnalysis',
        termType: 'geneExpression',
        samplelst: { groups: [control, kase] },
        tw: {
          q: { groups: [control, kase] },
          term: {
            name: 'KRAS no mutation vs KRAS mutated',
            type: 'samplelst',
            values: {
              'KRAS no mutation': {
                key: 'KRAS no mutation',
                label: 'KRAS no mutation',
                color: '#1b9e77',
                list: control.values,
              },
              'KRAS mutated': { key: 'KRAS mutated', label: 'KRAS mutated', color: '#d95f02', list: kase.values },
            },
          },
        },
        settings: { volcano: { method: 'wilcoxon', showPValueTable: true } },
      },
    ]);
  });

  it('lets extra volcano pins through but never over the method or the table', () => {
    const args = buildLauncherArgs({ ...deDirect, volcano: { rankBy: 'adjustedPValue', pValueType: 'original' } }, HOST);
    if (!('launchGdcDE' in args)) throw new Error('expected a DE launcher');
    const [plot] = args.state.plots;
    if (plot.chartType !== 'differentialAnalysis') throw new Error('expected the direct plot');
    expect(plot.settings.volcano).toEqual({
      rankBy: 'adjustedPValue',
      pValueType: 'original',
      method: 'wilcoxon',
      showPValueTable: true,
    });
  });

  it('seeds DEinput with saved-cohort terms and autoSubmit', () => {
    const filter0 = { and: [{ in: { case_id: ['SYNTH-CASE-0003'] } }] };
    const args = buildLauncherArgs(
      {
        kind: 'deInput',
        groups: [
          { name: 'A', cohortId: 'c1', filter0 },
          { name: 'B', cohortId: 'c2', filter0 },
        ],
      },
      HOST,
    );
    if (!('launchGdcDE' in args)) throw new Error('expected a DE launcher');
    expect(args.filter0).toBeNull();
    expect(args.state.plots).toEqual([
      {
        chartType: 'DEinput',
        autoSubmit: true,
        groups: ['A', 'B'].map((name, i) => ({
          name,
          filter: {
            type: 'tvslst',
            in: true,
            join: '',
            lst: [
              {
                type: 'tvs',
                tvs: {
                  term: { id: `c${i + 1}`, name, type: 'cohort', filter0, isleaf: true },
                  values: [{ key: `c${i + 1}`, label: name }],
                },
              },
            ],
          },
        })),
      },
    ]);
  });

  it('never carries a holder or update arguments', () => {
    for (const pinned of [survival, deDirect]) {
      const args = buildLauncherArgs(pinned, HOST);
      expect(args).not.toHaveProperty('holder');
      expect(args).not.toHaveProperty('updateArgs');
    }
  });
});

describe('canonicalJson', () => {
  it('sorts keys at every level, keeps array order and drops undefined fields', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 1], c: 'x' } })).toBe('{"a":{"c":"x","d":[3,1]},"b":1}');
    const withUndefined = JSON.parse('{"a":1}') as { [key: string]: number | null };
    Object.assign(withUndefined, { z: undefined });
    expect(canonicalJson(withUndefined)).toBe('{"a":1}');
  });

  it('refuses numbers JSON cannot carry', () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow('non-finite');
  });

  it('accepts integers and decimals with 1e-4 <= |x| < 1e15, which Python prints alike', () => {
    expect(canonicalJson([0, -3, 2 ** 53 - 1, 0.3, -0.0001, 1e-4, 999999999999999.9])).toBe(
      '[0,-3,9007199254740991,0.3,-0.0001,0.0001,999999999999999.9]',
    );
  });

  it.each([
    ['a decimal below 1e-4', 0.00005],
    ['a decimal at 1e15', 1e15 + 0.5],
    ['an integer JavaScript cannot hold exactly', 2 ** 53],
    ['an integer JavaScript prints in exponent form', 1e21],
    ['infinity', Number.POSITIVE_INFINITY],
  ])('refuses %s', (_label, value) => {
    expect(() => canonicalJson({ volcano: { pValue: value } })).toThrow('Cannot hash');
  });
});

describe('pinned-hash vectors (orion/contracts/fixtures/viz-pinned-vectors.json)', () => {
  it('covers every launcher kind', () => {
    expect(VECTORS.map((v) => v.pinned.kind).sort()).toEqual(['deDirect', 'deInput', 'oncomatrix', 'survival']);
  });

  it.each(VECTORS.map((v): [string, PinnedVector] => [v.name, v]))(
    'reproduces the canonical string and sha256 of "%s"',
    async (_name, vector) => {
      expect(canonicalJson(pinnedDocument(vector.pinned))).toBe(vector.canonical);
      expect(createHash('sha256').update(vector.canonical, 'utf8').digest('hex')).toBe(vector.sha256);
      expect(await hash(vector.pinned)).toBe(vector.sha256);
    },
  );
});

describe('pinnedFromVizSpec', () => {
  const snapshots = fixtureEvents().filter((e): e is StateSnapshotEvent => e.type === 'STATE_SNAPSHOT');
  const [spec] = snapshots[snapshots.length - 1].snapshot.vizSpecs;

  it("returns the J1 fixture's pinned inputs, whose hash matches the snapshot's pinnedHash", async () => {
    const pinned = pinnedFromVizSpec(spec);
    expect(pinned).toEqual({
      kind: 'survival',
      filter0: null,
      term: 'overall_survival',
      overlay: 'cgs_risk_category',
    });
    expect(await hash(pinned)).toBe(spec.pinnedHash);
  });

  it('refuses a spec whose launcher is not its pinned kind', () => {
    const mismatched: VizSpec = { ...spec, launcher: 'oncomatrix' };
    expect(() => pinnedFromVizSpec(mismatched)).toThrow('does not match');
  });
});

describe('pinnedHash', () => {
  it('is the sha256 of the canonical pinned document', async () => {
    const expected = createHash('sha256').update(canonicalJson(pinnedDocument(survival))).digest('hex');
    expect(await hash(survival)).toBe(expected);
    expect(canonicalJson(pinnedDocument(survival))).toBe(
      '{"filter0":null,"kind":"survival","overlay":"cgs_risk_category","schema":"orion.viz-pinned/v1","term":"overall_survival"}',
    );
  });

  it('pins the definition with a known vector, so the agent side can match it', async () => {
    expect(await hash(survival)).toBe('660a67ada3be378c148e83443173994dccfad7e7bb579eaac5a4f1f1f3d7f5de');
  });

  it('is stable across key order and sample order', async () => {
    const reordered: PinnedViz = {
      method: 'wilcoxon',
      groups: [
        { sampleIds: [7, 9, 3], name: 'KRAS no mutation' },
        { sampleIds: [2, 4, 1], name: 'KRAS mutated' },
      ],
      kind: 'deDirect',
    };
    expect(await hash(reordered)).toBe(await hash(deDirect));
    expect(await hash(deDirect)).toBe(await hash(deDirect));
  });

  it('changes with anything that changes the chart', async () => {
    if (deDirect.kind !== 'deDirect') throw new Error('fixture');
    const base = await hash(deDirect);
    const [control, kase] = deDirect.groups;
    const variants: PinnedViz[] = [
      { ...deDirect, groups: [kase, control] },
      { ...deDirect, method: 'edgeR' },
      { ...deDirect, groups: [control, { ...kase, sampleIds: [1, 2] }] },
      { ...deDirect, groups: [control, { ...kase, name: 'Mutated' }] },
      { ...deDirect, volcano: { foldChangeCutoff: 1 } },
    ];
    const hashes = await Promise.all(variants.map(hash));
    hashes.forEach((value) => expect(value).not.toBe(base));
    expect(new Set(hashes).size).toBe(variants.length);
    expect(await hash({ ...survival, filter0: { and: [] } })).not.toBe(await hash(survival));
  });

  it('returns 64 lowercase hex characters', async () => {
    expect(await hash(deDirect)).toMatch(/^[0-9a-f]{64}$/);
  });
});
