// The mode H fixture fingerprint (contract "Mode H fingerprint"; models.fingerprint_document and
// fingerprint_sha256 in the agent). In mode H the viewers read the local stack while the tools read
// AWS, so a card computes the local fingerprint from the four sources s1 reads and freezes, saying
// why, when it differs from the run's environment.fingerprintSha256.

import { FINGERPRINT_SCHEMA, type JsonValue } from '../agui/types';
import { canonicalJson, sha256Hex } from './ppPinnedArgs';

type JsonObject = { [key: string]: JsonValue };

export class FingerprintError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FingerprintError';
  }
}

export interface RankedGene {
  gene: string;
  cases: number;
}

/** The four sources, as fixture_fingerprint reads them (fingerprint-vectors.json `sources`). */
export interface FingerprintSources {
  /** GET /sandbox/status. */
  sandboxStatus: JsonValue;
  /** GET /analysis/v0/_version. */
  analysisVersion: JsonValue;
  /** GET /protein-paint/healthcheck. */
  healthcheck: JsonValue;
  /** The all-case topMutatedGenes ranking, normalised to [{gene, cases}] in returned order. */
  ranking: readonly RankedGene[];
}

export interface FingerprintDocument {
  schema: typeof FINGERPRINT_SCHEMA;
  sandbox: { status: JsonValue; synthetic: JsonValue; cases: JsonValue };
  analysis: { version: JsonValue };
  proteinpaint: { pkgver: JsonValue; codedate: JsonValue };
  ranking: RankedGene[];
}

const isObject = (value: JsonValue | undefined): value is JsonObject =>
  value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value);

const read = (value: JsonValue, key: string, source: string): JsonValue => {
  if (!isObject(value) || !(key in value)) throw new FingerprintError(`${source} has no ${key}`);
  return value[key];
};

/**
 * The document behind fingerprintSha256. Volatile fields (csrf, launch dates, init status) are
 * left out, so a restart does not change the fingerprint.
 */
export const fingerprintDocument = (sources: FingerprintSources): FingerprintDocument => {
  const info = read(sources.healthcheck, 'versionInfo', 'The ProteinPaint healthcheck');
  if (!isObject(info)) throw new FingerprintError('The ProteinPaint healthcheck carries no versionInfo object');
  return {
    schema: FINGERPRINT_SCHEMA,
    sandbox: {
      status: read(sources.sandboxStatus, 'status', 'GET /sandbox/status'),
      synthetic: read(sources.sandboxStatus, 'synthetic', 'GET /sandbox/status'),
      cases: read(sources.sandboxStatus, 'cases', 'GET /sandbox/status'),
    },
    analysis: { version: read(sources.analysisVersion, 'version', 'GET /analysis/v0/_version') },
    proteinpaint: {
      pkgver: read(info, 'pkgver', 'versionInfo'),
      codedate: read(info, 'codedate', 'versionInfo'),
    },
    ranking: sources.ranking.map(({ gene, cases }) => ({ gene, cases })),
  };
};

/** sha256 of the canonical JSON (portable numbers) of the fingerprint document. */
export const fingerprintSha256 = (document: FingerprintDocument, subtle?: SubtleCrypto): Promise<string> => {
  try {
    return sha256Hex(canonicalJson(document as unknown as JsonValue), subtle);
  } catch (error) {
    return Promise.reject(error);
  }
};

/** ProteinPaint's dt for SNV/indel; the sandbox has no other mutation class. */
const DT_SNV_INDEL = 1;

/**
 * topMutatedGenes `.genes[]` as [{gene, cases}], in returned order: `cases` is the count of the
 * gene's mutationStat entry with dt 1 (0 when it has none), as top_mutated_genes normalises it.
 */
export const rankingFromTopMutatedGenes = (response: JsonValue): RankedGene[] => {
  const genes = read(response, 'genes', 'topMutatedGenes');
  if (!Array.isArray(genes)) throw new FingerprintError('topMutatedGenes .genes is not a list');
  return genes.map((row, i) => {
    const gene = read(row, 'gene', `topMutatedGenes .genes[${i}]`);
    if (typeof gene !== 'string') throw new FingerprintError(`topMutatedGenes .genes[${i}].gene is not a string`);
    const stats = isObject(row) && Array.isArray(row.mutationStat) ? row.mutationStat : [];
    const snv = stats.find((s) => isObject(s) && s.dt === DT_SNV_INDEL);
    const count = isObject(snv) ? snv.count : 0;
    if (typeof count !== 'number') throw new FingerprintError(`topMutatedGenes .genes[${i}] count is not a number`);
    return { gene, cases: count };
  });
};

/** The golden `proteinpaint/termdb-topMutatedGenes.json` query, sent unchanged, as s1 sends it. */
export const FINGERPRINT_RANKING_QUERY = {
  genome: 'hg38',
  dslabel: 'MMRF',
  maxGenes: 50,
  geneFilter: 'CGC',
  filter0: { and: [] },
} as const;

/** Where the browser reads the four sources: the same local stack its viewers read. */
export interface FingerprintEndpoints {
  sandboxStatus: string;
  analysisVersion: string;
  healthcheck: string;
  topMutatedGenes: string;
}

export interface LocalFingerprint {
  document: FingerprintDocument;
  sha256: string;
}

const readJson = async (fetchFn: typeof fetch, url: string, init?: RequestInit): Promise<JsonValue> => {
  const response = await fetchFn(url, init);
  if (!response.ok) throw new FingerprintError(`${init?.method ?? 'GET'} ${url} answered ${response.status}`);
  try {
    return (await response.json()) as JsonValue;
  } catch {
    throw new FingerprintError(`${url} did not answer JSON`);
  }
};

/**
 * Reads the four sources in s1's order (three GETs, then the ranking as a JSON POST) and hashes
 * their document. Rejects with a FingerprintError when a source fails or lacks a field.
 */
export const computeLocalFingerprint = async (
  endpoints: FingerprintEndpoints,
  fetchFn: typeof fetch = (input, init) => globalThis.fetch(input, init),
  subtle?: SubtleCrypto,
): Promise<LocalFingerprint> => {
  const sandboxStatus = await readJson(fetchFn, endpoints.sandboxStatus);
  const analysisVersion = await readJson(fetchFn, endpoints.analysisVersion);
  const healthcheck = await readJson(fetchFn, endpoints.healthcheck);
  const ranking = rankingFromTopMutatedGenes(
    await readJson(fetchFn, endpoints.topMutatedGenes, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(FINGERPRINT_RANKING_QUERY),
    }),
  );
  const document = fingerprintDocument({ sandboxStatus, analysisVersion, healthcheck, ranking });
  return { document, sha256: await fingerprintSha256(document, subtle) };
};
