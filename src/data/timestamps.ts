import type { EntityRow } from '@almadar/core';

/** Rows leave every store with ISO-8601 timestamps; stores that hand back `Date`s (Postgres) are normalized. */
export function isoTimestamps(row: EntityRow): EntityRow {
  const out: EntityRow = { ...row };
  for (const key of ['createdAt', 'updatedAt']) {
    const value = out[key];
    if (value instanceof Date) out[key] = value.toISOString();
  }
  return out;
}
