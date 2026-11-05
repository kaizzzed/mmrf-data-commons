// derive_request_pinned (contract "Deriving requestPinnedHash"; models.derive_request_pinned in the
// agent): the pinned inputs a cited step's recorded request implies. The browser uses it to seed the
// DEinput fallback from de_run's request and to re-derive requestPinnedHash from the run record.

import type {
  CohortGroup,
  DeMethod,
  GqlFilter,
  JsonValue,
  PinnedKind,
  PinnedViz,
  SampleGroup,
  VolcanoPins,
} from '../agui/types';
import { pinnedHash } from './ppPinnedArgs';

type JsonObject = { [key: string]: JsonValue };

/** The recorded request (or output) does not have the shape its launcher's derivation reads. */
export class RequestPinnedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RequestPinnedError';
  }
}

const DE_METHODS: readonly DeMethod[] = ['wilcoxon', 'edgeR', 'limma'];

const isObject = (value: JsonValue | undefined): value is JsonObject =>
  value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value);

const field = (object: JsonObject, key: string, where: string): JsonValue => {
  if (!(key in object)) throw new RequestPinnedError(`${where} has no ${key}`);
  return object[key];
};

const text = (value: JsonValue, where: string): string => {
  if (typeof value !== 'string') throw new RequestPinnedError(`${where} is not a string`);
  return value;
};

const filterOrNull = (value: JsonValue, where: string): GqlFilter | null => {
  if (value === null) return null;
  if (!isObject(value)) throw new RequestPinnedError(`${where} is not a Gen3 filter`);
  return value;
};

const objects = (value: JsonValue, where: string): JsonObject[] => {
  if (!Array.isArray(value)) throw new RequestPinnedError(`${where} is not a list`);
  // As the agent does, entries that are not objects are skipped, then the count is checked.
  return value.filter(isObject);
};

const twoGroups = <T>(groups: T[]): [T, T] => {
  if (groups.length !== 2) throw new RequestPinnedError(`de_run's request has ${groups.length} groups, not 2`);
  return [groups[0], groups[1]];
};

/** Plain decimal digits of a finite number's shortest form (Number#toString, as Python's repr). */
const plainDecimal = (value: number): string => {
  const shortest = Math.abs(value).toString();
  const match = /^(\d+)(?:\.(\d+))?e([+-]\d+)$/.exec(shortest);
  if (!match) return shortest;
  const [, whole, fraction = '', exponentText] = match;
  const digits = whole + fraction;
  const point = whole.length + Number(exponentText);
  if (point <= 0) return `0.${'0'.repeat(-point)}${digits}`;
  if (point >= digits.length) return digits + '0'.repeat(point - digits.length);
  return `${digits.slice(0, point)}.${digits.slice(point)}`;
};

/** Adds one unit in the last place of a digit string ("129" -> "130", "99" -> "100"). */
const incrementDigits = (digits: string): string => {
  const out = digits.split('');
  for (let i = out.length - 1; i >= 0; i -= 1) {
    if (out[i] !== '9') {
      out[i] = String(Number(out[i]) + 1);
      return out.join('');
    }
    out[i] = '0';
  }
  return `1${out.join('')}`;
};

/**
 * Rounds half away from zero at `decimals` places, on the number's shortest decimal form
 * (contract "Fact values on screen"; Python's Decimal(repr(x)).quantize(..., ROUND_HALF_UP)).
 */
export const roundHalfAwayFromZero = (value: number, decimals: number): number => {
  if (!Number.isFinite(value)) throw new RequestPinnedError(`Cannot round ${value}`);
  const [whole, fraction = ''] = plainDecimal(value).split('.');
  if (fraction.length <= decimals) return value;
  const kept = whole + fraction.slice(0, decimals);
  const rounded = fraction[decimals] >= '5' ? incrementDigits(kept) : kept;
  const point = rounded.length - decimals;
  const magnitude = Number(decimals === 0 ? rounded : `${rounded.slice(0, point)}.${rounded.slice(point)}`);
  return value < 0 ? -magnitude : magnitude;
};

/**
 * The viewer's -log10 p cutoff to two decimals (0.05 -> 1.3), as de_run sends it in
 * volcanoRender and the deDirect card pins it. JavaScript's Math.log10 and Python's math.log10
 * may differ in the last bit; that changes the rounded value only within one ulp of a .xx5 tie.
 */
export const minusLog10 = (cutoff: number): number => {
  if (!Number.isFinite(cutoff) || cutoff <= 0) throw new RequestPinnedError(`pValueCutoff ${cutoff} is not above 0`);
  const value = roundHalfAwayFromZero(-Math.log10(cutoff), 2);
  // -log10(1) is -0; both sides print it as 0.
  return value === 0 ? 0 : value;
};

const survival = (request: JsonObject): PinnedViz => {
  const split = field(request, 'split', "survival_compare's request");
  if (!isObject(split)) throw new RequestPinnedError("survival_compare's request names no split");
  return {
    kind: 'survival',
    filter0: filterOrNull(field(request, 'scope', "survival_compare's request"), 'scope'),
    term: text(field(request, 'term', "survival_compare's request"), 'term'),
    overlay: text(field(split, 'overlay', 'split'), 'split.overlay'),
  };
};

const oncomatrix = (request: JsonObject, observed: JsonValue | undefined): PinnedViz => {
  const genes = isObject(observed) ? observed.genes : undefined;
  if (!Array.isArray(genes)) throw new RequestPinnedError("top_mutated_genes' output lists no genes");
  return {
    kind: 'oncomatrix',
    filter0: filterOrNull(field(request, 'filter0', "top_mutated_genes' request"), 'filter0'),
    genes: genes.filter(isObject).map((g, i) => text(field(g, 'gene', `genes[${i}]`), `genes[${i}].gene`)),
  };
};

const sampleIds = (value: JsonValue, where: string): number[] => {
  if (!Array.isArray(value) || !value.every((id) => typeof id === 'number' && Number.isInteger(id))) {
    throw new RequestPinnedError(`${where} is not a list of integer sample ids`);
  }
  return value as number[];
};

const deDirect = (request: JsonObject): PinnedViz => {
  const groups = objects(field(request, 'groups', "de_run's request"), 'groups').map(
    (g, i): SampleGroup => ({
      name: text(field(g, 'name', `groups[${i}]`), `groups[${i}].name`),
      sampleIds: sampleIds(field(g, 'sampleIds', `groups[${i}]`), `groups[${i}].sampleIds`),
    }),
  );
  const method = field(request, 'method', "de_run's request");
  if (typeof method !== 'string' || !DE_METHODS.includes(method as DeMethod)) {
    throw new RequestPinnedError(`method ${JSON.stringify(method)} is not a DE method`);
  }
  const pinned: Extract<PinnedViz, { kind: 'deDirect' }> = {
    kind: 'deDirect',
    groups: twoGroups(groups),
    method: method as DeMethod,
  };
  const thresholds = request.thresholds;
  if (isObject(thresholds)) {
    const cutoff = field(thresholds, 'pValueCutoff', 'thresholds');
    const foldChangeCutoff = field(thresholds, 'foldChangeCutoff', 'thresholds');
    const pValueType = field(thresholds, 'pValueType', 'thresholds');
    if (typeof cutoff !== 'number') throw new RequestPinnedError('pValueCutoff is not a number');
    if (typeof foldChangeCutoff !== 'number') throw new RequestPinnedError('foldChangeCutoff is not a number');
    if (pValueType !== 'adjusted' && pValueType !== 'original') {
      throw new RequestPinnedError(`pValueType ${JSON.stringify(pValueType)} is not adjusted or original`);
    }
    const volcano: VolcanoPins = { foldChangeCutoff, pValue: minusLog10(cutoff), pValueType };
    return { ...pinned, volcano };
  }
  return pinned;
};

const deInput = (request: JsonObject): PinnedViz => {
  const groups = objects(field(request, 'groups', "de_run's request"), 'groups').map((g, i): CohortGroup => {
    const filter0 = field(g, 'filter0', `groups[${i}]`);
    if (!isObject(filter0)) throw new RequestPinnedError(`groups[${i}].filter0 is not a Gen3 filter`);
    return {
      name: text(field(g, 'name', `groups[${i}]`), `groups[${i}].name`),
      cohortId: text(field(g, 'cohortId', `groups[${i}]`), `groups[${i}].cohortId`),
      filter0,
    };
  });
  return { kind: 'deInput', groups: twoGroups(groups) };
};

/**
 * The pinned form of the cited call's recorded `request` (and, for OncoMatrix, its `observed`):
 *
 * - survival (survival_compare): filter0 = scope, term, overlay = split.overlay
 * - oncomatrix (top_mutated_genes): filter0 = request.filter0, genes = the output's symbols in order
 * - deDirect (de_run): groups (name, sampleIds), method, volcano from thresholds when present
 * - deInput (de_run on saved cohorts): groups (name, cohortId, filter0)
 *
 * Throws RequestPinnedError when the request lacks what its launcher reads, such as a deInput
 * derivation from a de_run whose groups were never saved (no cohortId).
 */
export const deriveRequestPinned = (
  launcher: PinnedKind,
  request: JsonValue,
  observed?: JsonValue,
): PinnedViz => {
  if (!isObject(request)) throw new RequestPinnedError('The recorded request is not an object');
  switch (launcher) {
    case 'survival':
      return survival(request);
    case 'oncomatrix':
      return oncomatrix(request, observed);
    case 'deDirect':
      return deDirect(request);
    case 'deInput':
      return deInput(request);
  }
};

/** pinnedHash of deriveRequestPinned: what the agent records as the spec's requestPinnedHash. */
export const requestPinnedHash = (
  launcher: PinnedKind,
  request: JsonValue,
  observed?: JsonValue,
  subtle?: SubtleCrypto,
): Promise<string> => pinnedHash(deriveRequestPinned(launcher, request, observed), subtle);
