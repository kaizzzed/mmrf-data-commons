import type { Fact } from './agui/types';

export const formatDuration = (ms: number): string =>
  ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;

export const formatCount = (n: number): string => n.toLocaleString('en-US');

/** "Scope: <cohort name> · <n> cases", or "· count pending" before a count is known (chip and plan card). */
export const formatScope = (name: string, caseCount: number | null): string =>
  caseCount === null
    ? `Scope: ${name} · count pending`
    : `Scope: ${name} · ${formatCount(caseCount)} ${caseCount === 1 ? 'case' : 'cases'}`;

/** A citation chip names the plan row and the step, such as "Row 6 · s9 de_run". */
export const citationLabel = (fact: Pick<Fact, 'row' | 'stepId' | 'tool'>): string =>
  `Row ${fact.row} · ${fact.stepId} ${fact.tool}`;

// ------------------------------------------------------------------ format_fact
// A port of models.format_fact (contract "Fact values on screen"). Numbers are rounded half away
// from zero on their shortest decimal form, which Number#toString and Python's repr both print, so
// the arithmetic runs on that digit string rather than on binary floating point.

/** value = (negative ? -1 : 1) × digits × 10^exponent; `digits` has no leading zeros (zero is "0"). */
interface Decimal {
  negative: boolean;
  digits: string;
  exponent: number;
}

const stripLeadingZeros = (digits: string): string => digits.replace(/^0+(?=\d)/, '');

const toDecimal = (value: number): Decimal => {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/.exec(String(value));
  if (!match) throw new Error(`${value} is not a finite number`);
  const [, sign, whole, fraction = '', exp = '0'] = match;
  return {
    negative: sign === '-',
    digits: stripLeadingZeros(whole + fraction),
    exponent: Number(exp) - fraction.length,
  };
};

const isZero = (d: Decimal): boolean => /^0+$/.test(d.digits);

/** Adds one to a string of decimal digits. */
const increment = (digits: string): string => {
  const out = digits.split('');
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i] !== '9') {
      out[i] = String(Number(out[i]) + 1);
      return out.join('');
    }
    out[i] = '0';
  }
  return `1${out.join('')}`;
};

/** Rounds to a multiple of 10^exponent, half away from zero (Python's ROUND_HALF_UP). */
const quantize = (d: Decimal, exponent: number): Decimal => {
  if (d.exponent >= exponent) {
    return { ...d, digits: stripLeadingZeros(d.digits + '0'.repeat(d.exponent - exponent)), exponent };
  }
  const keep = d.digits.length - (exponent - d.exponent);
  const head = keep > 0 ? d.digits.slice(0, keep) : '0';
  const firstDropped = keep >= 0 ? d.digits[keep] : '0';
  const digits = firstDropped >= '5' ? increment(head) : head;
  return { negative: d.negative, digits: stripLeadingZeros(digits), exponent };
};

/** Fixed-point text keeping every digit the exponent implies ("1.0", "0.0342", "-0.00"). */
const fixed = (d: Decimal): string => {
  const sign = d.negative ? '-' : '';
  if (d.exponent >= 0) return sign + d.digits + '0'.repeat(d.exponent);
  const places = -d.exponent;
  const padded = d.digits.padStart(places + 1, '0');
  return `${sign}${padded.slice(0, -places)}.${padded.slice(-places)}`;
};

/** Python's _plain: trailing zeros and a bare point dropped, "-0" printed as "0". */
const plain = (d: Decimal): string => {
  let text = fixed(d);
  if (text.includes('.')) text = text.replace(/0+$/, '').replace(/\.$/, '');
  return text === '-0' || text === '' ? '0' : text;
};

const groupThousands = (whole: string): string => whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** Position of the most significant digit, as Decimal.adjusted() gives it. */
const adjusted = (d: Decimal): number => d.exponent + d.digits.length - 1;

const formatP = (d: Decimal): string => {
  if (isZero(d)) return '0';
  const magnitude = adjusted(d);
  if (magnitude < -3) {
    // Below 0.001: one decimal of e-notation, carrying into the exponent when it rounds to 10.
    let exponent = magnitude;
    let mantissa = quantize({ ...d, exponent: d.exponent - magnitude }, -1);
    if (mantissa.digits.length > 2) {
      mantissa = quantize({ ...mantissa, exponent: mantissa.exponent - 1 }, -1);
      exponent += 1;
    }
    return `${fixed(mantissa)}e${exponent}`;
  }
  return plain(quantize(d, magnitude - 2));
};

const formatLog2Fc = (d: Decimal): string => {
  const rounded = quantize(d, -2);
  return isZero(rounded) ? '0.00' : fixed(rounded);
};

const formatGrouped = (d: Decimal): string => {
  const rounded = quantize(d, -2);
  const sign = rounded.negative && !isZero(rounded) ? '-' : '';
  const [whole, fraction] = plain({ ...rounded, negative: false }).split('.');
  return `${sign}${groupThousands(whole)}${fraction ? `.${fraction}` : ''}`;
};

/**
 * The one way a fact value is written on screen (contract "Fact values on screen"): strings
 * unchanged; unit `p` as 0, one decimal of e-notation below 0.001 or three significant digits;
 * unit `log2FC` with two decimals; any other number with thousands separators and at most two
 * decimals. `agui/__fixtures__/fact-format-vectors.json` holds the cases.
 */
export const formatFact = (value: number | string, unit: string): string => {
  if (typeof value === 'string') return value;
  if (!Number.isFinite(value)) throw new Error(`${value} is not a finite number`);
  const d = toDecimal(value);
  if (unit === 'p') return formatP(d);
  if (unit === 'log2FC') return formatLog2Fc(d);
  return formatGrouped(d);
};
