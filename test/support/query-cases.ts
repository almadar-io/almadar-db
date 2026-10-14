/**
 * The shared push-down query cases. The fixture is copied from
 * packages/almadar-parity/fixtures/pushdown/query-cases.json (the source of truth the Rust kernel
 * also reads); keep the copy in sync. Every adapter that implements `queryPage` runs all of them,
 * minus the cases its declared `queryCapabilities` rule out, which each adapter test names.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { EntityRowSchema, RowQuerySchema, queryUnsupportedReason, type EntityRow, type PersistenceAdapter, type RowQuery } from '@almadar/core';

export interface QueryCase {
  name: string;
  query: RowQuery;
  expect: { ids: string[]; total: number };
}

const raw = JSON.parse(readFileSync(join(__dirname, '../fixtures/pushdown/query-cases.json'), 'utf8'));

export const queryFixture: { entity: string; rows: EntityRow[]; cases: QueryCase[] } = {
  entity: String(raw.entity),
  rows: raw.rows.map((row: object) => EntityRowSchema.parse(row)),
  cases: raw.cases.map((c: { name: string; query: object; expect: { ids: string[]; total: number } }) => ({
    name: String(c.name),
    query: RowQuerySchema.parse(c.query),
    expect: { ids: c.expect.ids.map(String), total: Number(c.expect.total) },
  })),
};

export const FIXTURE_ENTITY = queryFixture.entity;
export const FIXTURE_ROWS: readonly EntityRow[] = queryFixture.rows;

export function caseQuery(name: string): RowQuery {
  const found = queryFixture.cases.find((c) => c.name === name);
  if (!found) throw new Error(`no query case named ${name}`);
  return found.query;
}

/** Names of the cases `adapter` declares it can push down / cannot. */
export function partitionCases(adapter: PersistenceAdapter): { supported: QueryCase[]; declined: QueryCase[] } {
  const caps = adapter.queryCapabilities?.(FIXTURE_ENTITY);
  if (!caps) throw new Error('adapter declares no queryCapabilities');
  const supported: QueryCase[] = [];
  const declined: QueryCase[] = [];
  for (const c of queryFixture.cases) (queryUnsupportedReason(caps, c.query) === null ? supported : declined).push(c);
  return { supported, declined };
}

export function runQueryPageCases(name: string, make: () => Promise<PersistenceAdapter>): void {
  describe(`${name} — queryPage over the shared push-down cases`, () => {
    for (const c of queryFixture.cases) {
      it(c.name, async () => {
        const store = await make();
        const caps = store.queryCapabilities?.(FIXTURE_ENTITY);
        if (!caps || !store.queryPage) throw new Error(`${name} does not implement queryPage`);
        if (queryUnsupportedReason(caps, c.query) !== null) return;
        const page = await store.queryPage(FIXTURE_ENTITY, c.query);
        expect(page.rows.map((r) => r.id)).toEqual(c.expect.ids);
        expect(page.total).toBe(c.expect.total);
      });
    }
  });
}
