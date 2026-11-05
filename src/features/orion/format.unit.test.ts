import { readFileSync } from 'fs';
import path from 'path';
import { citationLabel, formatFact, formatScope } from './format';

/** agui/__fixtures__/fact-format-vectors.json, copied byte for byte from the contract. */
const { vectors } = JSON.parse(
  readFileSync(path.join(__dirname, 'agui', '__fixtures__', 'fact-format-vectors.json'), 'utf8'),
) as { vectors: { value: number | string; unit: string; text: string }[] };

describe('formatFact', () => {
  it('has vectors for every rule', () => {
    expect(new Set(vectors.map((v) => (typeof v.value === 'string' ? 'string' : v.unit === 'p' || v.unit === 'log2FC' ? v.unit : 'other')))).toEqual(
      new Set(['string', 'p', 'log2FC', 'other']),
    );
  });

  it.each(vectors.map((v) => [v.value, v.unit, v.text] as const))('writes %p (%s) as "%s"', (value, unit, text) => {
    expect(formatFact(value, unit)).toBe(text);
  });

  it.each([
    [0.9995, 'p', '1'],
    [0.00099951, 'p', '1.0e-3'],
    [-1234.567, 'cases', '-1,234.57'],
    [-0.001, 'days', '0'],
    [0.005, 'days', '0.01'],
    [0.0049, 'days', '0'],
    [1e21, 'genes', '1,000,000,000,000,000,000,000'],
    [-0.005, 'log2FC', '-0.01'],
    [123.456, 'p', '123'],
    [5e-324, 'p', '5.0e-324'],
  ] as const)('rounds %p (%s) half away from zero to "%s"', (value, unit, text) => {
    expect(formatFact(value, unit)).toBe(text);
  });

  it('refuses a number that is not finite', () => {
    expect(() => formatFact(Number.NaN, 'cases')).toThrow('not a finite number');
    expect(() => formatFact(Number.POSITIVE_INFINITY, 'p')).toThrow('not a finite number');
  });
});

describe('labels', () => {
  it('names the plan row and the step on a chip', () => {
    expect(citationLabel({ row: 6, stepId: 's9', tool: 'de_run' })).toBe('Row 6 · s9 de_run');
  });

  it('writes the scope line with its count, or count pending', () => {
    expect(formatScope('All cases', 1000)).toBe('Scope: All cases · 1,000 cases');
    expect(formatScope('One', 1)).toBe('Scope: One · 1 case');
    expect(formatScope('Black patients', null)).toBe('Scope: Black patients · count pending');
  });
});
