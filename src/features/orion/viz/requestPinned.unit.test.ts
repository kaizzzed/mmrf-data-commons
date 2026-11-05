import { createHash, webcrypto } from 'crypto';
import { readFileSync } from 'fs';
import path from 'path';
import type { JsonValue, PinnedKind, PinnedViz } from '../agui/types';
import { canonicalJson, pinnedDocument, pinnedHash } from './ppPinnedArgs';
import {
  deriveRequestPinned,
  minusLog10,
  RequestPinnedError,
  requestPinnedHash,
  roundHalfAwayFromZero,
} from './requestPinned';

const subtle = (globalThis.crypto?.subtle ?? webcrypto.subtle) as SubtleCrypto;

/** orion/contracts/fixtures/request-pinned-vectors.json, copied byte for byte. */
interface RequestPinnedVector {
  name: string;
  launcher: PinnedKind;
  request: JsonValue;
  observed?: JsonValue;
  pinned: PinnedViz;
  requestPinnedHash: string;
}
const FILE = JSON.parse(
  readFileSync(path.join(__dirname, '__fixtures__', 'request-pinned-vectors.json'), 'utf8'),
) as { schema: string; vectors: RequestPinnedVector[] };
const VECTORS = FILE.vectors;

const deRequest = (extra: Record<string, JsonValue> = {}): JsonValue => ({
  groups: [
    { name: 'Control', sampleIds: [3, 1] },
    { name: 'Case', sampleIds: [2] },
  ],
  method: 'wilcoxon',
  ...extra,
});

describe('request-pinned vectors (orion/contracts/fixtures/request-pinned-vectors.json)', () => {
  it('is the contract file and covers every launcher', () => {
    expect(FILE.schema).toBe('orion.request-pinned-vectors/v1');
    expect(new Set(VECTORS.map((v) => v.launcher))).toEqual(new Set(['survival', 'oncomatrix', 'deDirect', 'deInput']));
  });

  it.each(VECTORS.map((v): [string, RequestPinnedVector] => [v.name, v]))(
    'derives the pinned form and requestPinnedHash of "%s"',
    async (_name, vector) => {
      const derived = deriveRequestPinned(vector.launcher, vector.request, vector.observed);
      expect(derived).toEqual(vector.pinned);
      // Byte for byte: the same canonical document, so the same hash on both sides.
      expect(canonicalJson(pinnedDocument(derived))).toBe(canonicalJson(pinnedDocument(vector.pinned)));
      const canonical = canonicalJson(pinnedDocument(derived));
      expect(createHash('sha256').update(canonical, 'utf8').digest('hex')).toBe(vector.requestPinnedHash);
      expect(await requestPinnedHash(vector.launcher, vector.request, vector.observed, subtle)).toBe(
        vector.requestPinnedHash,
      );
      expect(await pinnedHash(vector.pinned, subtle)).toBe(vector.requestPinnedHash);
    },
  );
});

describe('deriveRequestPinned', () => {
  it('reads only what each launcher pins: extra request fields never change the hash', async () => {
    const [vector] = VECTORS.filter((v) => v.launcher === 'deDirect');
    const request = vector.request as { [key: string]: JsonValue };
    const padded = { ...request, extra: 'ignored', groups: (request.groups as JsonValue[]).map((g) => g) };
    expect(await requestPinnedHash('deDirect', padded, undefined, subtle)).toBe(vector.requestPinnedHash);
  });

  it('pins no volcano without thresholds, and the -log10 cutoff with them', () => {
    expect(deriveRequestPinned('deDirect', deRequest())).toEqual({
      kind: 'deDirect',
      groups: [
        { name: 'Control', sampleIds: [3, 1] },
        { name: 'Case', sampleIds: [2] },
      ],
      method: 'wilcoxon',
    });
    const pinned = deriveRequestPinned(
      'deDirect',
      deRequest({ thresholds: { pValueCutoff: 0.01, pValueType: 'original', foldChangeCutoff: 1 } }),
    );
    expect(pinned).toMatchObject({ volcano: { foldChangeCutoff: 1, pValue: 2, pValueType: 'original' } });
  });

  it('keeps the output gene order for OncoMatrix, whatever the request asked', () => {
    const pinned = deriveRequestPinned('oncomatrix', { filter0: null, geneCount: 2 }, {
      genes: [
        { gene: 'NRAS', cases: 5 },
        { gene: 'KRAS', cases: 5 },
      ],
      nextGene: { gene: 'TP53', cases: 5 },
    });
    expect(pinned).toEqual({ kind: 'oncomatrix', filter0: null, genes: ['NRAS', 'KRAS'] });
  });

  it.each<[string, PinnedKind, JsonValue, JsonValue | undefined]>([
    ['a request that is not an object', 'survival', [], undefined],
    ['survival with no split', 'survival', { scope: null, term: 'overall_survival', split: null }, undefined],
    ['survival with a string scope', 'survival', { scope: 'all', term: 't', split: { overlay: 'o' } }, undefined],
    ['OncoMatrix with no output genes', 'oncomatrix', { filter0: null }, { genes: null }],
    ['DE with one group', 'deDirect', { groups: [{ name: 'A', sampleIds: [1] }], method: 'wilcoxon' }, undefined],
    ['DE with a method the viewer lacks', 'deDirect', deRequest({ method: 'ttest' }), undefined],
    ['DE with fractional sample ids', 'deDirect', { groups: [{ name: 'A', sampleIds: [1.5] }, { name: 'B', sampleIds: [2] }], method: 'wilcoxon' }, undefined],
    ['DE with a zero p cutoff', 'deDirect', deRequest({ thresholds: { pValueCutoff: 0, pValueType: 'adjusted', foldChangeCutoff: 0.3 } }), undefined],
    ['DEinput on groups never saved (no cohortId)', 'deInput', deRequest(), undefined],
  ])('refuses %s', (_label, launcher, request, observed) => {
    expect(() => deriveRequestPinned(launcher, request, observed)).toThrow(RequestPinnedError);
  });
});

describe('minusLog10 and roundHalfAwayFromZero', () => {
  it.each([
    [0.05, 1.3],
    [0.01, 2],
    [0.1, 1],
    [0.001, 3],
    [0.5, 0.3],
    [1, 0],
    [1e-10, 10],
  ])('-log10(%p) to two decimals is %p', (cutoff, expected) => {
    expect(minusLog10(cutoff)).toBe(expected);
  });

  it('rounds half away from zero on the shortest decimal form, as Python Decimal ROUND_HALF_UP', () => {
    // 1.005 is stored as 1.00499999999999989...; its shortest form "1.005" rounds up, as Decimal(repr(x)) does.
    expect(roundHalfAwayFromZero(1.005, 2)).toBe(1.01);
    expect(roundHalfAwayFromZero(-1.005, 2)).toBe(-1.01);
    expect(roundHalfAwayFromZero(2.675, 2)).toBe(2.68);
    expect(roundHalfAwayFromZero(0.125, 2)).toBe(0.13);
    expect(roundHalfAwayFromZero(9.995, 2)).toBe(10);
    expect(roundHalfAwayFromZero(1.3010299956639813, 2)).toBe(1.3);
    expect(roundHalfAwayFromZero(1.2, 2)).toBe(1.2);
    expect(roundHalfAwayFromZero(1e-7, 2)).toBe(0);
    expect(roundHalfAwayFromZero(5e-3, 2)).toBe(0.01);
    expect(roundHalfAwayFromZero(1e21, 2)).toBe(1e21);
  });

  it('refuses a cutoff that is not above zero', () => {
    expect(() => minusLog10(0)).toThrow(RequestPinnedError);
    expect(() => minusLog10(-0.05)).toThrow(RequestPinnedError);
    expect(() => minusLog10(Number.NaN)).toThrow(RequestPinnedError);
  });
});
