import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { FULL_QUERY_CAPABILITIES, type PersistenceAdapter } from '@almadar/core';
import { InMemoryPersistence, MockPersistenceAdapter } from '../src/mock/index.js';
import { IndexedDbPersistence } from '../src/browser/index.js';
import { FIXTURE_ENTITY, FIXTURE_ROWS, partitionCases, queryFixture, runQueryPageCases } from './support/query-cases';

async function memory(): Promise<PersistenceAdapter> {
  const store = new InMemoryPersistence();
  store.seed({ [FIXTURE_ENTITY]: FIXTURE_ROWS.map((r) => ({ ...r })) });
  return store;
}

async function mock(): Promise<PersistenceAdapter> {
  const store = new MockPersistenceAdapter();
  for (const row of FIXTURE_ROWS) await store.create(FIXTURE_ENTITY, { ...row });
  return store;
}

let n = 0;
async function indexedDb(): Promise<PersistenceAdapter> {
  const store = await IndexedDbPersistence.open({ databaseName: `pushdown-${++n}`, entityTypes: [FIXTURE_ENTITY] });
  for (const row of FIXTURE_ROWS) await store.create(FIXTURE_ENTITY, { ...row });
  return store;
}

for (const [name, make] of [['InMemoryPersistence', memory], ['MockPersistenceAdapter', mock], ['IndexedDbPersistence', indexedDb]] as const) {
  runQueryPageCases(name, make);

  describe(`${name} — capabilities`, () => {
    it('declares every query form and pushes down all 29 cases', async () => {
      const store = await make();
      expect(store.queryCapabilities?.(FIXTURE_ENTITY)).toEqual(FULL_QUERY_CAPABILITIES);
      expect(partitionCases(store).declined).toEqual([]);
      expect(queryFixture.cases).toHaveLength(29);
    });

    it('control: an entity with no rows answers an empty page', async () => {
      const store = await make();
      const page = await store.queryPage?.(FIXTURE_ENTITY, { filter: { kind: 'compare', field: 'status', op: '==', value: 'nope' } });
      expect(page).toEqual({ rows: [], total: 0 });
    });
  });
}

describe('listPage callers are unaffected', () => {
  it('listPage is still absent on the memory adapters (the contract falls back over list)', async () => {
    expect((await memory()).listPage).toBeUndefined();
  });
});
