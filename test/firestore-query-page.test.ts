import { describe, it, expect, afterAll } from 'vitest';
import type { EntityRow, PersistenceAdapter } from '@almadar/core';
import { FirestorePersistence, firestoreRows, type RowFirestore } from '../src/firestore/persistence.js';
import { firestoreQueryCapabilities } from '../src/firestore/query-plan.js';
import { getFirestore, initializeFirebase } from '../src/firebase/index.js';
import { semanticFirestore } from './support/firestore-semantics';
import { FIXTURE_ENTITY, FIXTURE_ROWS, partitionCases, runQueryPageCases } from './support/query-cases';

const DECLINED = [
  'filter-equals', 'order-desc-missing-last', 'order-asc-missing-last', 'order-ties-break-by-id', 'not-equals-includes-missing',
  'range-and', 'range-skips-missing', 'or-two-fields', 'not-over-compare', 'not-over-missing-field', 'not-membership', 'array-contains-any',
  'contains-case-insensitive', 'contains-case-sensitive', 'is-null', 'is-not-null', 'policy-hides-most-rows',
];

async function seeded(firestore: RowFirestore, root: string, options: { orderableFields?: string[] } = {}): Promise<FirestorePersistence> {
  const store = new FirestorePersistence({ root, firestore, ...options });
  for (const row of FIXTURE_ROWS) await store.create(FIXTURE_ENTITY, { ...row });
  return store;
}

describe('FirestorePersistence.queryPage over the Firestore rules model', () => {
  const make = (): Promise<PersistenceAdapter> => seeded(semanticFirestore(), 'hosted/app-1');
  runQueryPageCases('FirestorePersistence (model)', make);

  it('declares what native filters express and declines the rest of the 29 cases by name', async () => {
    const { supported, declined } = partitionCases(await make());
    expect(declined.map((c) => c.name)).toEqual(DECLINED);
    expect(supported).toHaveLength(29 - DECLINED.length);
  });

  it('declares nothing when the connected store cannot run a plan, and refuses queryPage', async () => {
    const plain: RowFirestore = { collection: (path) => semanticFirestore().collection(path) };
    const { runPlan: _runPlan, ...bare } = plain.collection('x');
    const noPlans: RowFirestore = { collection: () => bare };
    const store = new FirestorePersistence({ root: '', firestore: noPlans });
    expect(store.queryCapabilities?.('Task')).toEqual({
      leaves: [], combinators: [], compareOps: [], orderableFields: { kind: 'listed', fields: [] }, window: false, exactTotal: false,
    });
    await expect(store.queryPage('Task', {})).rejects.toThrow(/runPlan/);
  });

  it('control: the window is applied by the store, total counts every match', async () => {
    const store = await make();
    const page = await store.queryPage(FIXTURE_ENTITY, { filter: { kind: 'compare', field: 'status', op: '==', value: 'open' }, offset: 2, limit: 3 });
    expect(page.rows.map((r) => r.id)).toEqual(['t04', 't06', 't08']);
    expect(page.total).toBe(7);
  });

  it('an unmatchable predicate answers empty without reading', async () => {
    const reads: string[] = [];
    const spy: RowFirestore = {
      collection: (path) => {
        reads.push(path);
        return semanticFirestore().collection(path);
      },
    };
    const store = new FirestorePersistence({ root: '', firestore: spy });
    expect(await store.queryPage('Task', { policy: { kind: 'const', value: false } })).toEqual({ rows: [], total: 0 });
    expect(reads).toEqual([]);
  });

  it('a host-declared orderable field sorts by it with ties by id', async () => {
    const store = new FirestorePersistence({ root: 'hosted/app-2', firestore: semanticFirestore(), orderableFields: ['rank'] });
    const rows: EntityRow[] = [{ id: 'c', rank: 2 }, { id: 'a', rank: 2 }, { id: 'b', rank: 1 }, { id: 'd', rank: 3 }];
    for (const row of rows) await store.create('Task', row);
    expect(store.queryCapabilities?.('Task')).toEqual(firestoreQueryCapabilities(['rank']));
    const asc = await store.queryPage('Task', { order: { field: 'rank', direction: 'asc' } });
    expect(asc.rows.map((r) => r.id)).toEqual(['b', 'a', 'c', 'd']);
    const desc = await store.queryPage('Task', { order: { field: 'rank', direction: 'desc' } });
    expect(desc.rows.map((r) => r.id)).toEqual(['d', 'a', 'c', 'b']);
    await expect(store.queryPage('Task', { order: { field: 'other', direction: 'asc' } })).rejects.toThrow(/order-field/);
  });
});

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('FirestorePersistence.queryPage on the Firestore emulator', () => {
  const root = `pushdown-tests/run-${Date.now()}`;
  let ready: Promise<FirestorePersistence> | undefined;
  const make = (): Promise<FirestorePersistence> => {
    ready ??= (async () => {
      initializeFirebase();
      return seeded(firestoreRows(getFirestore()), root);
    })();
    return ready;
  };

  afterAll(async () => {
    const store = await make();
    for (const row of await store.list(FIXTURE_ENTITY)) await store.delete(FIXTURE_ENTITY, row.id ?? '');
  });

  runQueryPageCases('FirestorePersistence (emulator)', make);

  it('declines exactly the cases the model declines', async () => {
    expect(partitionCases(await make()).declined.map((c) => c.name)).toEqual(DECLINED);
  });

  it('filters by document id, singly and in a list', async () => {
    const store = await make();
    const one = await store.queryPage(FIXTURE_ENTITY, { filter: { kind: 'compare', field: 'id', op: '==', value: 't05' } });
    expect(one.rows.map((r) => r.id)).toEqual(['t05']);
    const some = await store.queryPage(FIXTURE_ENTITY, { filter: { kind: 'member', field: 'id', values: ['t09', 't02', 'zz'] }, order: { field: 'id', direction: 'asc' } });
    expect(some.rows.map((r) => r.id)).toEqual(['t02', 't09']);
  });

  it('orders by a host-declared field with ties by id', async () => {
    const store = new FirestorePersistence({ root: `${root}-rank`, firestore: firestoreRows(getFirestore()), orderableFields: ['rank'] });
    const rows: EntityRow[] = [{ id: 'c', rank: 2 }, { id: 'a', rank: 2 }, { id: 'b', rank: 1 }, { id: 'd', rank: 3 }];
    for (const row of rows) await store.create('Task', row);
    const desc = await store.queryPage('Task', { order: { field: 'rank', direction: 'desc' }, offset: 1, limit: 2 });
    expect(desc.rows.map((r) => r.id)).toEqual(['a', 'c']);
    expect(desc.total).toBe(4);
    for (const row of rows) await store.delete('Task', row.id ?? '');
  });
});
