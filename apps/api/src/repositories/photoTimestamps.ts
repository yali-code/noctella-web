/** Narrow timestamp adapters for photo persistence; SQLite text values stay unchanged. */
export const intakeTimestampFields = ["createdAt", "updatedAt", "cancelledAt", "appliedAt", "finalizedAt"] as const;
export const photoTimestampFields = ["createdAt", "updatedAt", "processingUpdatedAt"] as const;
export const photoOutboxTimestampFields = ["availableAt", "lockedAt", "createdAt", "updatedAt", "completedAt", "deadLetteredAt"] as const;

function timestampDate(value: unknown, field: string): Date {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  // Require an explicit zone rather than interpreting a string in the host's local zone.
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    const date = new Date(value);
    const [year, month, day, hour, minute, second] = value.slice(0, 19).split(/[-T:]/).map(Number);
    const calendar = new Date(0);
    calendar.setUTCFullYear(year, month - 1, day);
    if (Number.isFinite(date.getTime()) && calendar.getUTCMonth() === month - 1 && calendar.getUTCDate() === day && hour < 24 && minute < 60 && second < 60) return date;
  }
  // Do not include input values, which may be sensitive, in diagnostics.
  throw new TypeError("INVALID_PHOTO_TIMESTAMP:" + field);
}

export function photoTimestampValues<T extends Record<string, unknown>>(values: T, fields: readonly string[], dateMode: boolean): T {
  if (!dateMode) return values;
  const result: Record<string, unknown> = { ...values };
  for (const field of fields) if (result[field] !== null && result[field] !== undefined) result[field] = timestampDate(result[field], field);
  return result as T;
}

/** Preserve the existing ISO-string contract when PostgreSQL returns native Dates. */
export function photoTimestampRecord<T extends Record<string, unknown> | null | undefined>(row: T, fields: readonly string[]): T {
  if (!row) return row;
  const result: Record<string, unknown> = { ...row };
  for (const field of fields) if (result[field] instanceof Date) result[field] = timestampDate(result[field], field).toISOString();
  return result as T;
}
