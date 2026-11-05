// Canonical cohort definitions and defSha256 (contract "Cohort definitions and defSha256"), the
// browser's half of orion_agent/models.py normalize_definition, canonical_definition, def_sha256
// and definition_from_filter_set. cohort/__fixtures__/cohort-def-vectors.json holds the cases.

import {
  COHORT_DEF_SCHEMA,
  type CanonicalDefinition,
  type ClauseOp,
  type FilterClause,
  type JsonValue,
  type WireFilterSet,
} from '../agui/types';
import { canonicalJson } from '../viz/ppPinnedArgs';
import { sha256Hex } from './sha256';

export const MAX_CASE_IDS = 10_000;
export const MAX_CLAUSES = 20;
const MAX_FIELD_LENGTH = 120;
const CASE_ID_FIELDS: ReadonlySet<string> = new Set(['case_id', 'cases.case_id']);
const CASE_ID = /^[A-Za-z0-9._:-]{1,64}$/;
/** ProteinPaint's "Create cohort" stores case ids as `{"cases.case_id": "<id>"}`. */
const LEGACY_CASE_KEY = 'cases.case_id';
const CLAUSE_OPS: ReadonlySet<string> = new Set(['in', '!=', '>', '>=', '<', '<=']);
const SINGLE_OPS: Readonly<Record<string, ClauseOp>> = {
  '=': 'in',
  '!=': '!=',
  '>': '>',
  '>=': '>=',
  '<': '<',
  '<=': '<=',
};

/** A definition the contract does not allow, or filters ORION cannot read. */
export class DefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DefinitionError';
  }
}

/** Orders strings by code point, as Python does; `<` compares UTF-16 code units instead. */
export const compareCodePoints = (a: string, b: string): number => {
  const left = a[Symbol.iterator]();
  const right = b[Symbol.iterator]();
  for (;;) {
    const x = left.next();
    const y = right.next();
    if (x.done || y.done) return x.done ? (y.done ? 0 : -1) : 1;
    const delta = (x.value.codePointAt(0) ?? 0) - (y.value.codePointAt(0) ?? 0);
    if (delta !== 0) return delta;
  }
};

const unique = <T>(values: readonly T[]): T[] => values.filter((v, i) => values.indexOf(v) === i);

/** canonicalJson, with a number outside the portable range reported as a DefinitionError. */
const canonical = (value: unknown): string => {
  try {
    return canonicalJson(value as JsonValue);
  } catch (err) {
    throw new DefinitionError(err instanceof Error ? err.message : 'Cannot hash this definition');
  }
};

const checkClause = (clause: FilterClause): void => {
  if (!clause.field || clause.field.length > MAX_FIELD_LENGTH) {
    throw new DefinitionError(`A clause field must have 1 to ${MAX_FIELD_LENGTH} characters`);
  }
  if (!CLAUSE_OPS.has(clause.op)) throw new DefinitionError(`${clause.field}: unknown op ${clause.op}`);
  if (clause.values.length === 0) throw new DefinitionError(`${clause.field}: a clause needs a value`);
  const kinds = new Set(clause.values.map((v) => typeof v));
  if (kinds.size > 1 || !(kinds.has('string') || kinds.has('number'))) {
    throw new DefinitionError(`${clause.field}: values are all strings or all numbers`);
  }
  if (clause.op !== 'in' && clause.values.length !== 1) {
    throw new DefinitionError(`${clause.field} ${clause.op} takes exactly one value`);
  }
};

const sortedValues = (values: readonly (string | number)[]): (string | number)[] => {
  const distinct = unique(values);
  return distinct.every((v) => typeof v === 'string')
    ? [...(distinct as string[])].sort(compareCodePoints)
    : [...(distinct as number[])].sort((a, b) => a - b);
};

const caseIdsDefinition = (ids: readonly string[]): CanonicalDefinition => {
  const caseIds = unique(ids).sort(compareCodePoints);
  if (caseIds.length > MAX_CASE_IDS) throw new DefinitionError(`More than ${MAX_CASE_IDS} case ids`);
  const bad = caseIds.find((id) => !CASE_ID.test(id));
  if (bad !== undefined) throw new DefinitionError(`Not a case id: ${bad}`);
  return { kind: 'case_ids', caseIds };
};

/**
 * The normalized form both sides hash: case ids deduplicated and sorted; clause values
 * deduplicated and sorted (numbers numerically, strings by code point); clauses deduplicated and
 * sorted by field, op and the canonical JSON of their values; a lone `in` clause on `case_id` or
 * `cases.case_id` becomes a case-ID list.
 */
export const normalizeDefinition = (definition: CanonicalDefinition): CanonicalDefinition => {
  if (definition.kind === 'case_ids') return caseIdsDefinition(definition.caseIds);
  if (definition.clauses.length > MAX_CLAUSES) throw new DefinitionError(`More than ${MAX_CLAUSES} clauses`);
  const byKey = new Map<string, FilterClause>();
  for (const clause of definition.clauses) {
    checkClause(clause);
    const normal: FilterClause = { field: clause.field, op: clause.op, values: sortedValues(clause.values) };
    const key = canonical(normal);
    if (!byKey.has(key)) byKey.set(key, normal);
  }
  const clauses = [...byKey.values()].sort(
    (a, b) =>
      compareCodePoints(a.field, b.field) ||
      compareCodePoints(a.op, b.op) ||
      compareCodePoints(canonical(a.values), canonical(b.values)),
  );
  if (clauses.length === 1 && CASE_ID_FIELDS.has(clauses[0].field) && clauses[0].op === 'in') {
    return caseIdsDefinition(clauses[0].values.map(String));
  }
  return { kind: 'filter', clauses };
};

/** Canonical JSON of `{"schema": "orion.cohort-def/v1", ...normalized definition}`; throws DefinitionError. */
export const canonicalDefinition = (definition: CanonicalDefinition): string => {
  // A number outside the range JavaScript and Python print alike has no portable hash.
  return canonical({ schema: COHORT_DEF_SCHEMA, ...normalizeDefinition(definition) });
};

/** defSha256: sha256 (lowercase hex) of the UTF-8 canonical definition. */
export const defSha256 = (definition: CanonicalDefinition): string =>
  sha256Hex(canonicalDefinition(definition));

// ------------------------------------------------------------------ reading a FilterSet

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const operandValue = (value: unknown): string | number => {
  const legacy = isRecord(value) && Object.keys(value).length === 1 ? value[LEGACY_CASE_KEY] : undefined;
  const scalar = typeof legacy === 'string' ? legacy : value;
  if (typeof scalar === 'string' || (typeof scalar === 'number' && Number.isFinite(scalar))) return scalar;
  throw new DefinitionError('A filter operand is not a string or a number');
};

const readOperation = (key: string, operation: unknown, clauses: FilterClause[]): void => {
  if (!isRecord(operation)) throw new DefinitionError(`${key}: not a filter operation`);
  const field = typeof operation.field === 'string' ? operation.field : key;
  const { operator, operands } = operation;
  if (operator === 'and' && Array.isArray(operands) && operands.length > 0) {
    for (const part of operands) readOperation(field, part, clauses);
    return;
  }
  if ((operator === 'in' || operator === 'includes') && Array.isArray(operands) && operands.length > 0) {
    clauses.push({ field, op: 'in', values: operands.map(operandValue) });
    return;
  }
  if (typeof operator === 'string' && operator in SINGLE_OPS && 'operand' in operation) {
    clauses.push({ field, op: SINGLE_OPS[operator], values: [operandValue(operation.operand)] });
    return;
  }
  throw new DefinitionError(`${field}: ORION cannot read operator ${String(operator)}`);
};

/**
 * A saved cohort's canonical definition, or null when ORION cannot read its filters: `or` over
 * more than one field, another operator (such as `excludes`), a non-scalar operand, more than 20
 * clauses or a number outside the canonical range. An unreadable cohort never matches; reading
 * never throws.
 */
export const definitionFromFilterSet = (filters: unknown): CanonicalDefinition | null => {
  if (!isRecord(filters) || !isRecord(filters.root)) return null;
  const { mode, root } = filters;
  if (mode !== 'and' && mode !== 'or') return null;
  if (mode === 'or' && Object.keys(root).length > 1) return null;
  try {
    const clauses: FilterClause[] = [];
    for (const [key, operation] of Object.entries(root)) readOperation(key, operation, clauses);
    if (clauses.length > MAX_CLAUSES) return null;
    const normal = normalizeDefinition({ kind: 'filter', clauses });
    canonicalDefinition(normal);
    return normal;
  } catch (err) {
    if (err instanceof DefinitionError) return null;
    throw err;
  }
};

/** defSha256 of a stored FilterSet, or null when it cannot be read. */
export const filterSetSha256 = (filters: unknown): string | null => {
  const definition = definitionFromFilterSet(filters);
  return definition ? defSha256(definition) : null;
};

// ------------------------------------------------------------------ writing a FilterSet

type WireOperation = Record<string, JsonValue>;

const clauseOperation = (clause: FilterClause): WireOperation =>
  clause.op === 'in'
    ? { operator: 'includes', field: clause.field, operands: clause.values }
    : { operator: clause.op, field: clause.field, operand: clause.values[0] };

/**
 * The FilterSet the browser writes for a definition (contract "save_cohorts tool call"): a
 * case-ID list as the platform's own `case_id in` form with sorted ids; a filter as one root
 * entry per field, several clauses on one field joined by `and`.
 */
export const filterSetForDefinition = (definition: CanonicalDefinition): WireFilterSet => {
  const normal = normalizeDefinition(definition);
  if (normal.kind === 'case_ids') {
    return {
      mode: 'and',
      root: { case_id: { operator: 'in', field: 'case_id', operands: normal.caseIds } },
    };
  }
  const byField = new Map<string, FilterClause[]>();
  for (const clause of normal.clauses) byField.set(clause.field, [...(byField.get(clause.field) ?? []), clause]);
  const root: Record<string, WireOperation> = {};
  for (const [field, clauses] of byField) {
    root[field] =
      clauses.length === 1 ? clauseOperation(clauses[0]) : { operator: 'and', operands: clauses.map(clauseOperation) };
  }
  return { mode: 'and', root };
};
