import { createHash, webcrypto } from 'crypto';
import { readFileSync } from 'fs';
import path from 'path';
import type { JsonValue, StateSnapshotEvent } from '../agui/types';
import { canonicalJson } from './ppPinnedArgs';
import {
  computeLocalFingerprint,
  FINGERPRINT_RANKING_QUERY,
  FingerprintError,
  fingerprintDocument,
  type FingerprintEndpoints,
  fingerprintSha256,
  type FingerprintSources,
  rankingFromTopMutatedGenes,
} from './fingerprint';

const subtle = (globalThis.crypto?.subtle ?? webcrypto.subtle) as SubtleCrypto;

/** orion/contracts/fixtures/fingerprint-vectors.json, copied byte for byte. */
interface FingerprintVector {
  name: string;
  sources: FingerprintSources;
  document: JsonValue;
  canonical: string;
  sha256: string;
}
const VECTORS = (
  JSON.parse(readFileSync(path.join(__dirname, '__fixtures__', 'fingerprint-vectors.json'), 'utf8')) as {
    vectors: FingerprintVector[];
  }
).vectors;

const ENDPOINTS: FingerprintEndpoints = {
  sandboxStatus: '/sandbox/status',
  analysisVersion: '/analysis/v0/_version',
  healthcheck: '/protein-paint/healthcheck',
  topMutatedGenes: '/protein-paint/termdb/topMutatedGenes',
};

/** A topMutatedGenes body as the local stack answers it (mutationStat per class). */
const topMutatedGenesBody = (ranking: readonly { gene: string; cases: number }[]): JsonValue => ({
  genes: ranking.map(({ gene, cases }) => ({ gene, mutationStat: [{ dt: 1, count: cases }] })),
});

const jsonResponse = (body: JsonValue, status = 200): Response =>
  ({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) }) as Response;

const stackFetch = (vector: FingerprintVector) => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchFn = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const body: Record<string, JsonValue> = {
      [ENDPOINTS.sandboxStatus]: vector.sources.sandboxStatus,
      [ENDPOINTS.analysisVersion]: vector.sources.analysisVersion,
      [ENDPOINTS.healthcheck]: vector.sources.healthcheck,
      [ENDPOINTS.topMutatedGenes]: topMutatedGenesBody(vector.sources.ranking),
    };
    return Promise.resolve(jsonResponse(body[url]));
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
};

describe('fingerprint vectors (orion/contracts/fixtures/fingerprint-vectors.json)', () => {
  it.each(VECTORS.map((v): [string, FingerprintVector] => [v.name, v]))(
    'reproduces the document, canonical string and sha256 of "%s"',
    async (_name, vector) => {
      const document = fingerprintDocument(vector.sources);
      expect(document).toEqual(vector.document);
      expect(canonicalJson(document as unknown as JsonValue)).toBe(vector.canonical);
      expect(createHash('sha256').update(vector.canonical, 'utf8').digest('hex')).toBe(vector.sha256);
      expect(await fingerprintSha256(document, subtle)).toBe(vector.sha256);
    },
  );

  it('ignores csrf and the launch date, and changes with one ranking count', () => {
    const [local, restart, offByOne] = VECTORS;
    expect(restart.sha256).toBe(local.sha256);
    expect(offByOne.sha256).not.toBe(local.sha256);
  });

  it("equals the J1 fixture's environment fingerprint, which s1 computed from the same sources", () => {
    const lines = readFileSync(path.join(__dirname, '..', 'agui', '__fixtures__', 'j1-complete.events.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)) as { type: string });
    const snapshots = lines.filter((e): e is StateSnapshotEvent => e.type === 'STATE_SNAPSHOT');
    expect(snapshots[snapshots.length - 1].snapshot.environment.fingerprintSha256).toBe(VECTORS[0].sha256);
  });
});

describe('rankingFromTopMutatedGenes', () => {
  it('reads the dt 1 count per gene in returned order', () => {
    expect(
      rankingFromTopMutatedGenes({
        genes: [
          { gene: 'KRAS', mutationStat: [{ dt: 1, count: 480 }] },
          { gene: 'DIS3', mutationStat: [{ dt: 4, count: 9 }, { dt: 1, count: 280 }] },
          { gene: 'MYC', mutationStat: [{ dt: 4, count: 3 }] },
        ],
      }),
    ).toEqual([
      { gene: 'KRAS', cases: 480 },
      { gene: 'DIS3', cases: 280 },
      { gene: 'MYC', cases: 0 },
    ]);
  });

  it('refuses a body without genes or symbols', () => {
    expect(() => rankingFromTopMutatedGenes({ data: [] })).toThrow(FingerprintError);
    expect(() => rankingFromTopMutatedGenes({ genes: [{ mutationStat: [] }] })).toThrow(FingerprintError);
  });
});

describe('fingerprintDocument', () => {
  it('needs the healthcheck versionInfo and each status field', () => {
    const [vector] = VECTORS;
    expect(() => fingerprintDocument({ ...vector.sources, healthcheck: { status: 'ok' } })).toThrow('versionInfo');
    expect(() => fingerprintDocument({ ...vector.sources, sandboxStatus: { status: 'OK' } })).toThrow('synthetic');
    expect(() => fingerprintDocument({ ...vector.sources, analysisVersion: {} })).toThrow('version');
  });
});

describe('computeLocalFingerprint', () => {
  it("reads the four sources in s1's order, POSTs the golden ranking query, and hashes the document", async () => {
    const [vector] = VECTORS;
    const { fetchFn, calls } = stackFetch(vector);
    const result = await computeLocalFingerprint(ENDPOINTS, fetchFn, subtle);
    expect(result.sha256).toBe(vector.sha256);
    expect(result.document).toEqual(vector.document);
    expect(calls.map((c) => c.url)).toEqual([
      ENDPOINTS.sandboxStatus,
      ENDPOINTS.analysisVersion,
      ENDPOINTS.healthcheck,
      ENDPOINTS.topMutatedGenes,
    ]);
    expect(calls.slice(0, 3).every((c) => c.init?.method === undefined && c.init?.body === undefined)).toBe(true);
    expect(calls[3].init?.method).toBe('POST');
    expect(JSON.parse(String(calls[3].init?.body))).toEqual(FINGERPRINT_RANKING_QUERY);
    expect(FINGERPRINT_RANKING_QUERY).toEqual({
      genome: 'hg38',
      dslabel: 'MMRF',
      maxGenes: 50,
      geneFilter: 'CGC',
      filter0: { and: [] },
    });
  });

  it('rejects when a source answers an error', async () => {
    const fetchFn = jest.fn(() => Promise.resolve(jsonResponse({ error: 'down' }, 503))) as unknown as typeof fetch;
    await expect(computeLocalFingerprint(ENDPOINTS, fetchFn, subtle)).rejects.toThrow('answered 503');
  });
});
