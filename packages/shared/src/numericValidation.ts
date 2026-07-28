/**
 * Sprint 79 correction: shared strict numeric validation. `Number(x) < 0` /
 * `Number(x) > 100` style range checks silently pass NaN through (NaN < 0 and
 * NaN > 100 are both false), and `Number("garbage")` silently becomes NaN
 * rather than failing — so malformed input (empty string, "abc", null coerced
 * incorrectly, Infinity) could previously reach storage as NaN or as the
 * original non-numeric value. This module is the single place invalid
 * numeric ERP input is rejected instead of silently coerced.
 */

export class NumericValidationError extends Error {}

export interface NumericValidationOptions {
  min?: number;
  max?: number;
  integer?: boolean;
}

/**
 * Rejects anything that is not a genuine finite number: NaN, +/-Infinity,
 * non-numeric strings, booleans, objects/arrays, and out-of-range or
 * non-integer values per `options`. Numeric strings (e.g. "20", "20.5") are
 * accepted since HTTP JSON bodies and form inputs commonly carry numbers as
 * strings; empty/whitespace-only strings are rejected rather than becoming 0.
 */
export function assertValidNumber(value: unknown, fieldName: string, options: NumericValidationOptions = {}): number {
  if (typeof value === "boolean" || value === null || Array.isArray(value) || (typeof value === "object")) {
    throw new NumericValidationError(`${fieldName} must be a valid number`);
  }
  if (typeof value === "string" && value.trim() === "") {
    throw new NumericValidationError(`${fieldName} must be a valid number`);
  }
  const n = Number(value);
  if (!Number.isFinite(n)) throw new NumericValidationError(`${fieldName} must be a valid number`);
  if (options.integer && !Number.isInteger(n)) throw new NumericValidationError(`${fieldName} must be a whole number`);
  if (options.min != null && n < options.min) throw new NumericValidationError(`${fieldName} must be at least ${options.min}`);
  if (options.max != null && n > options.max) throw new NumericValidationError(`${fieldName} must be at most ${options.max}`);
  return n;
}

/** Same as assertValidNumber, but only validates when value is not null/undefined — for optional/partial-update fields. Returns undefined when value is null/undefined. */
export function assertValidNumberIfPresent(value: unknown, fieldName: string, options: NumericValidationOptions = {}): number | undefined {
  if (value === undefined || value === null) return undefined;
  return assertValidNumber(value, fieldName, options);
}
