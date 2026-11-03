export class LearningError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'LearningError'; }
}

export function check(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new LearningError(code, message);
}
export function immutable<T>(value: T): T {
  const clone = structuredClone(value);
  const freeze = (item: unknown): void => { if (item && typeof item === 'object' && !Object.isFrozen(item)) { for (const child of Object.values(item)) freeze(child); Object.freeze(item); } };
  freeze(clone); return clone;
}
export function timestamp(value: string): number {
  check(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value), 'INVALID_TIME', 'Use an explicit UTC timestamp.');
  const milliseconds = Date.parse(value);
  check(Number.isFinite(milliseconds) && new Date(milliseconds).toISOString().slice(0, 19) === value.slice(0, 19), 'INVALID_TIME', 'The timestamp is not a real UTC date.');
  return milliseconds;
}
export const normalizeText = (value: string): string => value.normalize('NFKC').toLocaleLowerCase('en-US').trim().replace(/\s+/g, ' ').replace(/[.!?]+$/, '');
export const unique = <T>(items: T[]): T[] => [...new Set(items)];
export const DAY = 86_400_000;

export interface Rational { numerator: bigint; denominator: bigint }
const gcd = (left: bigint, right: bigint): bigint => { left = left < 0n ? -left : left; right = right < 0n ? -right : right; while (right) [left, right] = [right, left % right]; return left || 1n; };
function rational(numerator: bigint, denominator: bigint): Rational {
  check(denominator !== 0n, 'INVALID_NUMBER', 'A fraction cannot have zero as its denominator.');
  if (denominator < 0n) { numerator = -numerator; denominator = -denominator; }
  const divisor = gcd(numerator, denominator); return { numerator: numerator / divisor, denominator: denominator / divisor };
}
/** Parses bounded decimal/scientific notation or one integer fraction; never evaluates expressions. */
export function parseNumeric(value: string): Rational {
  const input = value.trim();
  check(input.length > 0 && input.length <= 80, 'INVALID_NUMBER', 'Enter a bounded decimal or simple fraction.');
  let result: Rational;
  const fraction = /^([+-]?\d{1,15})\s*\/\s*([+-]?\d{1,15})$/.exec(input);
  if (fraction) result = rational(BigInt(fraction[1]), BigInt(fraction[2]));
  else {
    const decimal = /^([+-]?)(\d{1,15})(?:\.(\d{1,15}))?(?:[eE]([+-]?\d{1,2}))?$/.exec(input)
      ?? /^([+-]?)()\.(\d{1,15})(?:[eE]([+-]?\d{1,2}))?$/.exec(input);
    check(decimal, 'INVALID_NUMBER', 'Use a decimal or a simple fraction, without a formula.');
    const exponent = Number(decimal[4] ?? 0), fractional = decimal[3] ?? '';
    check(Math.abs(exponent) <= 12 && (decimal[2] + fractional).length <= 18, 'NUMBER_OUT_OF_RANGE', 'This answer has too many digits or an exponent outside −12 to 12.');
    let numerator = BigInt((decimal[2] || '0') + fractional) * (decimal[1] === '-' ? -1n : 1n);
    let denominator = 10n ** BigInt(fractional.length);
    if (exponent >= 0) numerator *= 10n ** BigInt(exponent); else denominator *= 10n ** BigInt(-exponent);
    result = rational(numerator, denominator);
  }
  check(Math.abs(asNumber(result)) <= 1e12 && result.denominator <= 10n ** 27n, 'NUMBER_OUT_OF_RANGE', 'The supported magnitude is at most one trillion.');
  return result;
}
export const asNumber = (value: Rational): number => Number(value.numerator) / Number(value.denominator);
export const multiply = (left: Rational, right: Rational): Rational => rational(left.numerator * right.numerator, left.denominator * right.denominator);
export const equalRational = (left: Rational, right: Rational): boolean => left.numerator * right.denominator === right.numerator * left.denominator;
export const printRational = (value: Rational): string => value.denominator === 1n ? String(value.numerator) : `${value.numerator}/${value.denominator}`;
export const absoluteDifference = (left: Rational, right: Rational): Rational => { const result = rational(left.numerator * right.denominator - right.numerator * left.denominator, left.denominator * right.denominator); return { ...result, numerator: result.numerator < 0n ? -result.numerator : result.numerator }; };
export const compareRational = (left: Rational, right: Rational): number => left.numerator * right.denominator < right.numerator * left.denominator ? -1 : left.numerator * right.denominator > right.numerator * left.denominator ? 1 : 0;
/** Exact decimal representation of an already validated finite configuration number. */
export function configurationNumber(value: number): Rational {
  check(Number.isFinite(value) && value >= 0, 'INVALID_TOLERANCE', 'Tolerance must be finite and nonnegative.');
  const [coefficient, power] = value.toString().split('e'), [whole, fraction = ''] = coefficient.split('.');
  const exponent = Number(power ?? 0) - fraction.length, digits = BigInt(whole + fraction);
  return exponent >= 0 ? rational(digits * 10n ** BigInt(exponent), 1n) : rational(digits, 10n ** BigInt(-exponent));
}
