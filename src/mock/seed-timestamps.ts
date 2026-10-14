import type { EntityRow, FieldValue } from '@almadar/core';

/** The store keeps timestamps as ISO strings; a supplied Date or non-empty string is kept, anything else is absent. */
export function isoTimestamp(value: FieldValue | undefined): string | undefined {
  if (value instanceof Date) return value.toISOString();
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** A seeded row with `createdAt`/`updatedAt`: an authored value is kept, an absent or blank one is `now`. */
export function stampSeedTimestamps(row: EntityRow, now: string): EntityRow {
  return {
    ...row,
    createdAt: isoTimestamp(row.createdAt) ?? now,
    updatedAt: isoTimestamp(row.updatedAt) ?? now,
  };
}
